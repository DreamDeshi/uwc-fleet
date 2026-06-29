/**
 * Auto-dispatch engine — Development Brief Section 4.
 *
 * The core selection logic (`selectTruck`) and the return-trip helper
 * (`enRouteZones`) are PURE — no DB, no Date.now() — so they can be unit
 * tested directly (see tests/dispatch.test.ts). `autoDispatchTrip` is the
 * thin DB orchestration layer that gathers candidates, runs the pure engine,
 * writes the assignment, and notifies the driver.
 *
 * Algorithm: Best-Fit Decreasing bin-packing.
 *   Rule A — single order: assign to the smallest available truck that fits.
 *   Rule B — consolidation: combine onto a truck already serving the same zone
 *            if current load + new order ≤ max capacity.
 *   Driver priority zones (truck.priority_zones) are preferred over adjacent
 *   coverage; zone adjacency lets a P2 driver pick up a K1 order when no K1
 *   driver is free. Hard constraint: never exceed a truck's max_pallets.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { sendPushNotifications } from "../lib/pushNotifications";
import { palletEquivalents } from "../lib/pallets";
import { isSerializationConflict } from "../lib/prismaErrors";
import { claimPendingTrip } from "./tripAssignment";

// ── Pure engine types ─────────────────────────────────────────────────

export interface DispatchOrder {
  pallets: number;
  zone: string | null; // primary destination zone (first stop)
}

export interface TruckCandidate {
  plate: string;
  driverId: string;
  maxPallets: number;
  currentLoad: number; // pallets already committed to active trips
  coverageZones: string[]; // truck.priority_zones = its driver's coverage
  activeZones: string[]; // destination zones of this truck's active trips
}

export interface TruckSelection {
  plate: string;
  driverId: string;
  reason: string;
}

// ── A1/A2 (Taiping/Ipoh) driver-priority rules — INTERNAL LORRY RATE sheet ──
// These two zones are NOT open to the whole fleet: the sheet names exactly who
// may serve them. Encoded here as plate constants so the rules read literally.
const A1_A2_ZONES = ["A1", "A2"];
const PRIMARY_A1_A2_PLATE = "PLX 2406"; // Mohd Azmi — the primary A1/A2 driver
const BACKUP_A1_A2_PLATE = "PND 1888"; // Mohd Shahar — only if PLX 2406 unavailable
const SMALL_LOAD_A1_A2_PLATE = "PRH 5292"; // Khoo — only for orders under 2 pallets
const KHOO_MAX_A1_A2_PALLETS = 2; // Khoo may take A1/A2 only when pallets < this

/**
 * Narrow the fitting trucks to those *allowed* to serve this order's zone.
 *
 * For any zone other than A1/A2 the set is returned unchanged. For A1 (Taiping)
 * or A2 (Ipoh) the INTERNAL LORRY RATE sheet's priority applies:
 *   1. Mohd Azmi / PLX 2406 is the primary driver — whenever he fits and is
 *      available he is the ONLY eligible truck (nobody else takes A1/A2 while
 *      Azmi is free).
 *   2. If PLX 2406 is unavailable (busy elsewhere or not in the pool), the
 *      backups are Mohd Shahar / PND 1888 (any size) and Khoo / PRH 5292, but
 *      Khoo only for orders strictly under 2 pallets (a 2-pallet A1/A2 order
 *      must not go to Khoo even though PRH could physically hold 2).
 *   3. Every other truck (the 17.5ft lorries) is never eligible for A1/A2.
 *
 * "PLX available" is derived purely from the passed candidates (it appears in
 * the fitting set) — no DB lookup — so a busy or absent PLX both open the
 * backups, while an idle, fitting PLX locks A1/A2 to him.
 */
function filterA1A2Eligible(order: DispatchOrder, fitting: TruckCandidate[]): TruckCandidate[] {
  if (order.zone == null || !A1_A2_ZONES.includes(order.zone)) return fitting;

  const plxAvailable = fitting.some((c) => c.plate === PRIMARY_A1_A2_PLATE);
  if (plxAvailable) {
    return fitting.filter((c) => c.plate === PRIMARY_A1_A2_PLATE);
  }

  return fitting.filter((c) => {
    if (c.plate === BACKUP_A1_A2_PLATE) return true; // Shahar backs up A1/A2, any size
    if (c.plate === SMALL_LOAD_A1_A2_PLATE) return order.pallets < KHOO_MAX_A1_A2_PALLETS; // Khoo: <2 pallets only
    return false; // 17.5ft lorries never serve A1/A2
  });
}

/**
 * Pick the best truck for one order, or null if none fits.
 *
 * A truck is a candidate when it has spare capacity for the order AND is not
 * already out serving a *different* zone (a truck mid-delivery to zone X is
 * unavailable; one already heading to the order's own zone can consolidate).
 *
 * A1/A2 orders are first narrowed to the drivers the INTERNAL LORRY RATE sheet
 * permits (see filterA1A2Eligible). Among the remaining candidates we rank by
 * tier (consolidation > covers zone > adjacent > any), then Best-Fit
 * Decreasing: prefer the smallest truck that fits so large trucks stay free for
 * large orders, breaking ties by tightest remaining space.
 */
export function selectTruck(
  order: DispatchOrder,
  candidates: TruckCandidate[],
  adjacency: Record<string, string[]>
): TruckSelection | null {
  const zone = order.zone;
  const adjacentToOrder = (zone && adjacency[zone]) || [];

  const fittingAll = candidates.filter((c) => {
    const remaining = c.maxPallets - c.currentLoad;
    if (remaining < order.pallets) return false; // hard overload prevention
    const busyElsewhere = c.activeZones.length > 0 && !c.activeZones.every((z) => z === zone);
    return !busyElsewhere;
  });

  // Apply the A1/A2 driver-priority gate BEFORE tier/Best-Fit ranking.
  const fitting = filterA1A2Eligible(order, fittingAll);
  if (fitting.length === 0) return null;

  const scored = fitting.map((c) => {
    const remaining = c.maxPallets - c.currentLoad;
    const consolidates = zone != null && c.currentLoad > 0 && c.activeZones.includes(zone);
    const covers = zone != null && c.coverageZones.includes(zone);
    const adjacent = c.coverageZones.some((z) => adjacentToOrder.includes(z));
    const tier = consolidates ? 0 : covers ? 1 : adjacent ? 2 : 3;
    return { c, remaining, tier };
  });

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.c.maxPallets !== b.c.maxPallets) return a.c.maxPallets - b.c.maxPallets; // smallest truck that fits
    if (a.remaining !== b.remaining) return a.remaining - b.remaining; // tightest fit
    return a.c.plate.localeCompare(b.c.plate); // deterministic tie-break
  });

  const best = scored[0];
  const why =
    best.tier === 0
      ? `consolidated onto a truck already serving ${zone}`
      : best.tier === 1
        ? `driver covers zone ${zone}`
        : best.tier === 2
          ? `adjacent-zone driver for ${zone}`
          : `next available truck for ${zone ?? "destination"}`;
  return {
    plate: best.c.plate,
    driverId: best.c.driverId,
    reason: `${why}; fits ${order.pallets}/${best.c.maxPallets} pallets`,
  };
}

// Zones a truck passes through on the way to/back from `zone`, so the engine
// can offer pending en-route orders to the same driver (Brief: P2→A2 passes
// through A1). Kept explicit and small; confirm the full corridor with UWC.
const EN_ROUTE: Record<string, string[]> = {
  A2: ["A1"], // Ipoh run passes Taiping — offer A1 pickups on the return leg
  A1: ["A2"], // a Taiping run can continue down the same southern corridor
};

export function enRouteZones(zone: string | null): string[] {
  if (!zone) return [];
  return EN_ROUTE[zone] ?? [];
}

// ── DB helpers ─────────────────────────────────────────────────────────

const ACTIVE_TRIP_STATUSES = ["assigned", "in_progress"] as const;

// 4×4-pallet-equivalent load for a set of cargo lines (see lib/pallets).
function orderPallets(cargo: { pallet_type: string; quantity: number }[]): number {
  return palletEquivalents(cargo);
}

function primaryZone(stops: { consignee: { zone_code: string } }[]): string | null {
  return stops[0]?.consignee.zone_code ?? null;
}

/** Resolve an actor for the audit log when dispatch runs without a logged-in user. */
async function systemActorId(preferred?: string): Promise<string | null> {
  if (preferred) return preferred;
  const admin = await prisma.user.findFirst({
    where: { role: "admin", status: "active" },
    select: { id: true },
  });
  return admin?.id ?? null;
}

export interface DispatchResult {
  assigned: boolean;
  reason: string;
  trip?: Awaited<ReturnType<typeof loadTripWithRelations>>;
  assignment?: TruckSelection;
  returnTripOffers?: { id: string; ticket_number: string; zone: string | null }[];
}

function loadTripWithRelations(id: string) {
  return prisma.trip.findUnique({
    where: { id },
    include: {
      requestor: { select: { id: true, name: true, phone: true } },
      driver: { select: { id: true, name: true, phone: true } },
      truck: true,
      route_type: true,
      stops: { include: { consignee: true }, orderBy: { sequence: "asc" } },
      cargo_details: true,
      documents: { orderBy: { uploaded_at: "desc" } },
    },
  });
}

/**
 * Run the engine for one pending trip and assign the best driver+truck.
 *
 * Best-effort and idempotent-ish: returns `{ assigned:false }` (never throws on
 * "no truck") so callers — the endpoint, the post-create hook, and the 15-min
 * timeout sweep — can all use it safely. `actorId` is the admin who triggered
 * it (endpoint); background callers omit it and the audit log falls back to the
 * bootstrap admin.
 */
export async function autoDispatchTrip(tripId: string, actorId?: string): Promise<DispatchResult> {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: {
      cargo_details: { select: { pallet_type: true, quantity: true } },
      stops: { orderBy: { sequence: "asc" }, select: { consignee: { select: { zone_code: true } } } },
    },
  });
  if (!trip) return { assigned: false, reason: "Trip not found." };
  if (trip.status !== "pending") return { assigned: false, reason: "Trip is not pending." };

  const order: DispatchOrder = {
    pallets: orderPallets(trip.cargo_details),
    zone: primaryZone(trip.stops),
  };

  const actor = await systemActorId(actorId);

  // Gather candidates, pick a truck, and claim the trip atomically under
  // Serializable isolation so two concurrent dispatches (e.g. the 15-min sweep
  // racing a manual approve, or two sweeps) can't double-assign the same trip or
  // overfill a truck. Reading each truck's live load inside the transaction lets
  // Postgres detect the read-write conflict and abort one with P2034; the
  // status-guarded claim makes the same-trip case deterministic (loser → raced).
  let selection: TruckSelection | null = null;
  let raced = false;
  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const trucks = await tx.truck.findMany({
          where: { is_available: true, driver: { is: { status: "active" } } },
          include: {
            driver: { select: { id: true } },
            trips: {
              where: { status: { in: [...ACTIVE_TRIP_STATUSES] }, id: { not: tripId } },
              select: {
                cargo_details: { select: { pallet_type: true, quantity: true } },
                stops: {
                  orderBy: { sequence: "asc" },
                  take: 1,
                  select: { consignee: { select: { zone_code: true } } },
                },
              },
            },
          },
        });

        const candidates: TruckCandidate[] = trucks
          .filter((t) => t.driver) // safety: driver relation present
          .map((t) => ({
            plate: t.plate,
            driverId: t.driver!.id,
            maxPallets: t.max_pallets,
            currentLoad: t.trips.reduce((sum, tr) => sum + orderPallets(tr.cargo_details), 0),
            coverageZones: t.priority_zones,
            activeZones: t.trips
              .map((tr) => tr.stops[0]?.consignee.zone_code)
              .filter((z): z is string => Boolean(z)),
          }));

        const zoneRows = await tx.zone.findMany({
          select: { code: true, adjacentTo: { select: { code: true } } },
        });
        const adjacency: Record<string, string[]> = Object.fromEntries(
          zoneRows.map((z) => [z.code, z.adjacentTo.map((a) => a.code)])
        );

        const sel = selectTruck(order, candidates, adjacency);
        if (!sel) return { sel: null as TruckSelection | null, raced: false };

        // Status-guarded claim: a concurrent dispatch that already assigned this
        // trip leaves us with count 0 → we lost the race.
        const won = await claimPendingTrip(tx, tripId, {
          driver_id: sel.driverId,
          truck_plate: sel.plate,
          pending_alert_sent: true, // it's handled now; don't ping admins about it
        });
        if (!won) return { sel: null as TruckSelection | null, raced: true };

        if (actor) {
          await tx.auditLog.create({
            data: {
              user_id: actor,
              action: "trip.auto_dispatched",
              table_name: "Trip",
              record_id: tripId,
            },
          });
        }
        return { sel, raced: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    selection = outcome.sel;
    raced = outcome.raced;
  } catch (err) {
    if (isSerializationConflict(err)) {
      // Lost a write-conflict with a concurrent dispatch. Best-effort: leave the
      // trip pending so the other writer (or the 15-min sweep) handles it.
      return { assigned: false, reason: "Concurrent dispatch in progress; will retry." };
    }
    throw err;
  }

  if (raced) {
    return { assigned: false, reason: "Trip was already assigned by a concurrent dispatch." };
  }
  if (!selection) {
    return { assigned: false, reason: "No available truck has capacity for this order." };
  }

  const updated = await loadTripWithRelations(tripId);

  // Notify the assigned driver (best-effort, never blocks).
  const driverDevice = await prisma.user.findUnique({
    where: { id: selection.driverId },
    select: { expo_push_token: true },
  });
  const destLabel =
    updated?.stops[0]?.consignee.area ||
    updated?.stops[0]?.consignee.company_name ||
    order.zone ||
    "destination";
  await sendPushNotifications([driverDevice?.expo_push_token], {
    title: "New trip assigned",
    body: `New trip assigned: ${destLabel}`,
    data: { type: "trip_assigned", tripId },
  });

  // Return-trip matching: pending orders en-route to the assigned zone, offered
  // to the same driver (not auto-assigned — the admin/driver decides).
  const enRoute = enRouteZones(order.zone);
  const returnTripOffers =
    enRoute.length > 0
      ? (
          await prisma.trip.findMany({
            where: {
              status: "pending",
              id: { not: tripId },
              stops: { some: { consignee: { zone_code: { in: enRoute } } } },
            },
            select: {
              id: true,
              ticket_number: true,
              stops: { orderBy: { sequence: "asc" }, take: 1, select: { consignee: { select: { zone_code: true } } } },
            },
          })
        ).map((t) => ({ id: t.id, ticket_number: t.ticket_number, zone: t.stops[0]?.consignee.zone_code ?? null }))
      : [];

  return {
    assigned: true,
    reason: selection.reason,
    trip: updated,
    assignment: selection,
    returnTripOffers,
  };
}
