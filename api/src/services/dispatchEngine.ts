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
 *   One-active-trip-per-driver: a driver already out on an assigned/in_progress
 *            trip is never a candidate — not even for same-zone consolidation.
 *            (Stacking a second order onto a busy driver caused the in_progress
 *            PLX 2406 to keep being re-picked.)
 *   Driver priority zones (truck.priority_zones) are preferred over adjacent
 *   coverage; zone adjacency lets a P2 driver pick up a K1 order when no K1
 *   driver is free. Hard constraint: never exceed a truck's max_pallets.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { sendPushNotifications } from "../lib/pushNotifications";
import { palletEquivalents, isUnsizedForDispatch } from "../lib/pallets";
import { isSerializationConflict } from "../lib/prismaErrors";
import { claimPendingTrip } from "./tripAssignment";
import { truckRateSnapshot, snapshotStopZonePoints } from "./rateSnapshot";
import { effectiveTruckRates, effectiveZonePoints } from "./pendingRates";
import { leaveDateFilter } from "./driverLeave";
import { mytDateKey } from "./incentiveEngine";
import { roadworthyWhere } from "./truckEligibility";
import { recordTripEvent } from "../lib/tripHistory";
import { CONFLICT_STATUSES, ASSIGNMENT_CONFLICT_BUFFER_MS } from "./schedulingConflict";
import {
  estimateOperatingWindow,
  formatMinutesToHm,
  type OperatingWindowEstimate,
} from "./operatingWindow";

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
const PRIMARY_A1_A2_PLATE = "PLX 2406"; // the primary A1/A2 driver's truck
const BACKUP_A1_A2_PLATE = "PND 1888"; // backup — only if PLX 2406 unavailable
const SMALL_LOAD_A1_A2_PLATE = "PRH 5292"; // only for orders under 2 pallets
const SMALL_LOAD_MAX_A1_A2_PALLETS = 2; // PRH 5292 may take A1/A2 only when pallets < this

/**
 * Narrow the fitting trucks to those *allowed* to serve this order's zone.
 *
 * For any zone other than A1/A2 the set is returned unchanged. For A1 (Taiping)
 * or A2 (Ipoh) the INTERNAL LORRY RATE sheet's priority applies:
 *   1. PLX 2406's driver is the primary — whenever that truck fits and is
 *      available it is the ONLY eligible truck (nobody else takes A1/A2 while
 *      PLX 2406 is free).
 *   2. If PLX 2406 is unavailable (busy elsewhere or not in the pool), the
 *      backups are PND 1888 (any size) and PRH 5292, but PRH only for orders
 *      strictly under 2 pallets (a 2-pallet A1/A2 order must not go to PRH
 *      even though it could physically hold 2).
 *   3. Every other truck (the 17.5ft lorries) is never eligible for A1/A2.
 *
 * "PLX available" is derived purely from the passed candidates (it appears in
 * the fitting set) — no DB lookup — so a busy or absent PLX both open the
 * backups, while an idle, fitting PLX locks A1/A2 to that truck.
 */
function filterA1A2Eligible(order: DispatchOrder, fitting: TruckCandidate[]): TruckCandidate[] {
  if (order.zone == null || !A1_A2_ZONES.includes(order.zone)) return fitting;

  const plxAvailable = fitting.some((c) => c.plate === PRIMARY_A1_A2_PLATE);
  if (plxAvailable) {
    return fitting.filter((c) => c.plate === PRIMARY_A1_A2_PLATE);
  }

  return fitting.filter((c) => {
    if (c.plate === BACKUP_A1_A2_PLATE) return true; // PND 1888 backs up A1/A2, any size
    if (c.plate === SMALL_LOAD_A1_A2_PLATE) return order.pallets < SMALL_LOAD_MAX_A1_A2_PALLETS; // PRH 5292: <2 pallets only
    return false; // 17.5ft lorries never serve A1/A2
  });
}

/**
 * Pick the best truck for one order, or null if none fits.
 *
 * A truck is a candidate when its driver has NO active trip and it has spare
 * capacity for the order. One active trip per driver is a hard rule: a truck
 * already out on a trip — even one heading to the order's own zone — is never a
 * candidate. (Previously a same-zone truck could consolidate a second order,
 * which kept handing new trips to a driver who was already rolling.)
 *
 * A1/A2 orders are first narrowed to the drivers the INTERNAL LORRY RATE sheet
 * permits (see filterA1A2Eligible). Among the remaining candidates we rank by
 * tier (covers zone > adjacent > any), then Best-Fit Decreasing: prefer the
 * smallest truck that fits so large trucks stay free for large orders, breaking
 * ties by tightest remaining space.
 */
export function selectTruck(
  order: DispatchOrder,
  candidates: TruckCandidate[],
  adjacency: Record<string, string[]>
): TruckSelection | null {
  const zone = order.zone;
  const adjacentToOrder = (zone && adjacency[zone]) || [];

  const fittingAll = candidates.filter((c) => {
    // One active trip per driver: a truck already on an active trip (any load or
    // destination) is out of the running — no consolidation onto a busy driver.
    // This is a deliberate trade-off vs the spec sheet's Rule B (stack same-zone
    // orders onto one truck until it's full): stacking kept handing new orders
    // to a driver who was already out. Consolidation still happens WITHIN a
    // booking (one trip can carry several stops); we just don't pile a second
    // booking onto a rolling truck.
    if (c.currentLoad > 0 || c.activeZones.length > 0) return false;
    const remaining = c.maxPallets - c.currentLoad;
    if (remaining < order.pallets) return false; // hard overload prevention
    return true;
  });

  // Apply the A1/A2 driver-priority gate BEFORE tier/Best-Fit ranking.
  const fitting = filterA1A2Eligible(order, fittingAll);
  if (fitting.length === 0) return null;

  const scored = fitting.map((c) => {
    const remaining = c.maxPallets - c.currentLoad;
    // Zone match beats everything: a driver whose coverage includes the order's
    // zone outranks a merely-adjacent one (Mr. Teh's P2↔K1 rule), who in turn
    // outranks "any free truck".
    const covers = zone != null && c.coverageZones.includes(zone);
    const adjacent = c.coverageZones.some((z) => adjacentToOrder.includes(z));
    const tier = covers ? 0 : adjacent ? 1 : 2; // 0 = own zone, 1 = neighbour, 2 = anyone
    return { c, remaining, tier };
  });

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    // Within a tier: smallest truck that fits — sending the 1-tonner on a
    // 2-pallet run keeps the 30-footers free for big orders (and saves fuel,
    // which is the whole point of Mr. Teh's "most cost-effective lorry" ask).
    if (a.c.maxPallets !== b.c.maxPallets) return a.c.maxPallets - b.c.maxPallets; // smallest truck that fits
    if (a.remaining !== b.remaining) return a.remaining - b.remaining; // tightest fit
    return a.c.plate.localeCompare(b.c.plate); // deterministic tie-break
  });

  const best = scored[0];
  const why =
    best.tier === 0
      ? `driver covers zone ${zone}`
      : best.tier === 1
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

/**
 * Timeline note for an auto-assignment — persists WHY the engine chose this
 * truck (exact-zone / adjacent / next-available; fits N/M pallets) on the
 * trip's immutable status history, where the admin trip detail renders it.
 * Pure; unit-tested in tests/dispatch.test.ts.
 */
export function autoAssignNote(
  driverName: string | null,
  plate: string,
  reason: string
): string {
  const who = driverName ? `${driverName} · ${plate}` : plate;
  return `${who} (auto — ${reason})`;
}

/**
 * The failure mirror of autoAssignNote: WHY the engine could not place a
 * booking, persisted to Trip.auto_dispatch_note alongside the
 * auto_dispatch_failed flag so the board's "needs attention" card tells the
 * dispatcher the remedy (override the window / free capacity / fix rates)
 * instead of a bare "failed". Pure; unit-tested in tests/dispatch.test.ts.
 */
export function autoDispatchFailureNote(
  windowExceeded: OperatingWindowEstimate | null
): string {
  if (windowExceeded) {
    return windowExceeded.reason === "pickup_outside_window"
      ? `Pickup is outside the operating window (${formatMinutesToHm(windowExceeded.windowStartMin)}–${formatMinutesToHm(windowExceeded.windowEndMin)}).`
      : `Estimated completion ${windowExceeded.completionLabel} exceeds the ${formatMinutesToHm(windowExceeded.windowEndMin)} operating window.`;
  }
  return "No available truck has capacity for this order.";
}

// ── DB helpers ─────────────────────────────────────────────────────────

// What counts as "this driver/truck is already out on a job" for auto-dispatch.
// Deliberately stricter than the manual path (which only blocks on in_progress):
// auto never stacks work on a driver who holds an assignment they haven't started.
const ACTIVE_TRIP_STATUSES = ["assigned", "in_progress"] as const;

// 4×4-pallet-equivalent load for a set of cargo lines (see lib/pallets).
function orderPallets(
  cargo: { pallet_type: string; quantity: number; estimated_pallets?: number | null }[]
): number {
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
      cargo_details: { select: { pallet_type: true, quantity: true, estimated_pallets: true } },
      stops: { orderBy: { sequence: "asc" }, select: { consignee: { select: { zone_code: true } } } },
    },
  });
  if (!trip) return { assigned: false, reason: "Trip not found." };
  if (trip.status !== "pending") return { assigned: false, reason: "Trip is not pending." };

  // Unsized cargo (carton/"Others" with no requestor estimate) has no pallet
  // footprint by conversion, so a 0-equivalent order "fits" every truck and
  // would silently take the SMALLEST. Route it to MANUAL assignment via the
  // needs-attention flag instead (same mechanism as ZONE_POINTS_MISSING below),
  // so an admin sizes it and picks the truck. Cargo WITH an estimate flows
  // through normally (orderPallets counts the estimate).
  if (isUnsizedForDispatch(trip.cargo_details)) {
    const reason = "Cargo size not specified — manual assignment required.";
    await prisma.trip.updateMany({
      where: { id: tripId, status: "pending" },
      data: { auto_dispatch_failed: true, auto_dispatch_note: reason },
    });
    return { assigned: false, reason };
  }

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
  // Leave is date-scoped: exclude drivers whose leave covers the trip's PICKUP
  // MYT day — a driver on leave that day is out of the pool for THIS booking
  // but stays eligible for bookings picked up on other dates.
  const pickupDateKey = mytDateKey(trip.pickup_datetime);

  let selection: TruckSelection | null = null;
  let raced = false;
  let windowExceeded: OperatingWindowEstimate | null = null;
  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const trucks = await tx.truck.findMany({
          // One active trip per driver: exclude any truck whose driver is already
          // out on an assigned/in_progress trip, so a busy driver is never handed
          // a second order (this is what kept re-picking the in_progress PLX 2406).
          where: {
            is_available: true,
            // Roadworthiness gate: expired insurance / road tax / permit →
            // never a candidate (query form of truckEligibility). No force
            // exists in auto — the trip goes needs-attention and the admin
            // decides manually (where only the permit is overridable).
            ...roadworthyWhere(new Date()),
            driver: {
              is: {
                status: "active",
                trips_driven: { none: { status: { in: [...ACTIVE_TRIP_STATUSES] } } },
                // On leave for the pickup date → not a candidate (query form of
                // driverLeave.leaveCoversDate).
                leaves: { none: leaveDateFilter(pickupDateKey) },
              },
            },
          },
          include: {
            driver: { select: { id: true, name: true } },
            trips: {
              where: { status: { in: [...ACTIVE_TRIP_STATUSES] }, id: { not: tripId } },
              select: {
                cargo_details: { select: { pallet_type: true, quantity: true, estimated_pallets: true } },
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
          .filter((t) => t.driver) // safety: a truck with no assigned driver (e.g. "4 Wheel") can't be dispatched
          .map((t) => ({
            plate: t.plate,
            driverId: t.driver!.id,
            maxPallets: t.max_pallets,
            // Pallets committed to this truck's OTHER active trips. The driver
            // filter above already excludes busy drivers, so this is belt and
            // braces for selectTruck's capacity math.
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

        // Scheduling-conflict skip (roadmap #2): a candidate whose driver or
        // truck already has another trip within the pickup buffer is ineligible.
        // Layered alongside the one-active-trip filter above (which already
        // excludes drivers on an assigned/in_progress trip); this additionally
        // covers the pickup-time buffer and the truck dimension.
        const pickupMs = trip.pickup_datetime.getTime();
        const conflictRows = await tx.trip.findMany({
          where: {
            id: { not: tripId },
            status: { in: [...CONFLICT_STATUSES] },
            OR: [
              { driver_id: { in: candidates.map((c) => c.driverId) } },
              { truck_plate: { in: candidates.map((c) => c.plate) } },
            ],
            pickup_datetime: {
              gte: new Date(pickupMs - ASSIGNMENT_CONFLICT_BUFFER_MS),
              lte: new Date(pickupMs + ASSIGNMENT_CONFLICT_BUFFER_MS),
            },
          },
          select: { driver_id: true, truck_plate: true, pickup_datetime: true },
        });
        const conflictedDrivers = new Set<string>();
        const conflictedPlates = new Set<string>();
        for (const x of conflictRows) {
          if (Math.abs(x.pickup_datetime.getTime() - pickupMs) >= ASSIGNMENT_CONFLICT_BUFFER_MS) continue;
          if (x.driver_id) conflictedDrivers.add(x.driver_id);
          if (x.truck_plate) conflictedPlates.add(x.truck_plate);
        }
        const eligibleCandidates = candidates.filter(
          (c) => !conflictedDrivers.has(c.driverId) && !conflictedPlates.has(c.plate)
        );

        const sel = selectTruck(order, eligibleCandidates, adjacency);
        if (!sel) {
          return { sel: null as TruckSelection | null, raced: false, window: null as OperatingWindowEstimate | null };
        }

        // Operating-window cutoff (Phase 3): the chosen truck's run must finish
        // within its operating window (and the pickup must be inside it). The flat
        // estimate is truck-independent for a given trip, so a breach means no
        // truck can serve it in-window — do NOT auto-assign; leave it pending and
        // let the caller flag it (reason "exceeds operating window"). pickup_datetime
        // is never mutated.
        const selTruck = trucks.find((t) => t.plate === sel.plate);
        // Per-stop zone points scale the drive-leg estimate (distance proxy);
        // a zone without a rate row falls back to the flat per-leg figure.
        const stopZones = trip.stops.map((s) => s.consignee.zone_code);
        const windowRates = await tx.destinationRate.findMany({
          where: { zone_code: { in: [...new Set(stopZones)] } },
        });
        // Points effective NOW (a staged next-day edit is invisible) — the
        // same values the assignment snapshot will freeze below.
        const windowPoints = new Map(
          windowRates.map((r) => [r.zone_code, effectiveZonePoints(r, new Date())])
        );
        const windowEst = estimateOperatingWindow({
          pickupDateTime: trip.pickup_datetime,
          stopCount: trip.stops.length,
          stopPoints: stopZones.map((z) => windowPoints.get(z) ?? null),
          windowStart: selTruck?.operating_hours_start,
          windowEnd: selTruck?.operating_hours_end,
        });
        if (windowEst.exceedsWindow) {
          return { sel: null as TruckSelection | null, raced: false, window: windowEst };
        }

        // Status-guarded claim: a concurrent dispatch that already assigned this
        // trip leaves us with count 0 → we lost the race. The claim also freezes
        // the truck's rates onto the trip (rate lock): finalization pays at these
        // values even if an admin edits the rates while the trip is in flight.
        // The rates frozen are those EFFECTIVE right now — a staged rate edit
        // is invisible until its next-MYT-day cutoff (client rule).
        const won = await claimPendingTrip(tx, tripId, {
          driver_id: sel.driverId,
          truck_plate: sel.plate,
          pending_alert_sent: true, // it's handled now; don't ping admins about it
          auto_dispatch_failed: false, // self-clearing: a later sweep placed it
          auto_dispatch_note: null, // cleared with the flag it annotates
          ...(selTruck ? truckRateSnapshot(effectiveTruckRates(selTruck, new Date())) : {}),
        });
        if (!won) {
          return { sel: null as TruckSelection | null, raced: true, window: null as OperatingWindowEstimate | null };
        }
        await snapshotStopZonePoints(tx, tripId);

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
        // actorId null: the assignment was system-driven (auto-dispatch), not a
        // person — the timeline distinguishes this from a manual admin approve.
        // The note carries the engine's selection reason so a completed
        // auto-dispatch permanently records WHY this truck was chosen.
        const driverName = trucks.find((t) => t.plate === sel.plate)?.driver?.name ?? null;
        await recordTripEvent(tx, {
          tripId,
          event: "assigned",
          actorId: null,
          note: autoAssignNote(driverName, sel.plate, sel.reason),
        });
        return { sel, raced: false, window: null as OperatingWindowEstimate | null };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    selection = outcome.sel;
    raced = outcome.raced;
    windowExceeded = outcome.window;
  } catch (err) {
    if (isSerializationConflict(err)) {
      // Lost a write-conflict with a concurrent dispatch. Best-effort: leave the
      // trip pending so the other writer (or the 15-min sweep) handles it.
      return { assigned: false, reason: "Concurrent dispatch in progress; will retry." };
    }
    if (err instanceof ApiError && err.code === "ZONE_POINTS_MISSING") {
      // Configuration error, not a race: a stop's zone has no destination
      // points, so the snapshot refused to write a silent 1-point payday.
      // Leave the trip pending and raise the needs-attention flag so an admin
      // fixes the rates instead of the booking vanishing into a log line.
      await prisma.trip.updateMany({
        where: { id: tripId, status: "pending" },
        data: { auto_dispatch_failed: true, auto_dispatch_note: err.message },
      });
      return { assigned: false, reason: err.message };
    }
    throw err;
  }

  if (raced) {
    return { assigned: false, reason: "Trip was already assigned by a concurrent dispatch." };
  }
  if (!selection) {
    // No eligible driver/truck for this booking. Flag it so web admins get a
    // distinct, persistent "needs attention — auto-dispatch failed" signal
    // (Phase 2), instead of it being indistinguishable from an awaiting-manual
    // pending trip. The status==pending guard means we never flag a trip a
    // concurrent writer just assigned; the flag self-clears on any transition
    // out of pending (manual assign / later sweep / cancel / reject).
    // Distinguish the operating-window breach (Phase 3) from a plain no-truck
    // failure. The note is persisted next to the flag (same guard, same
    // self-clearing lifecycle) so the board can show the dispatcher WHY —
    // repeated sweep retries simply overwrite it, never accumulate.
    const reason = autoDispatchFailureNote(windowExceeded);
    await prisma.trip.updateMany({
      where: { id: tripId, status: "pending" },
      data: { auto_dispatch_failed: true, auto_dispatch_note: reason },
    });
    return { assigned: false, reason };
  }

  const updated = await loadTripWithRelations(tripId);

  // Notify the assigned driver AND the requestor (best-effort, never blocks) —
  // mirrors the manual-approve path. Auto mode is the default, so without the
  // requestor leg the person who booked would only hear about their driver by
  // WhatsApping the dispatcher — the workflow this system replaces. NOTE: Expo
  // pushes only reach native installs; web users still see the assignment on
  // the next in-app refresh, and the payload keeps parity for installed apps.
  const [driverDevice, requestorDevice] = await Promise.all([
    prisma.user.findUnique({
      where: { id: selection.driverId },
      select: { expo_push_token: true },
    }),
    updated
      ? prisma.user.findUnique({
          where: { id: updated.requestor.id },
          select: { expo_push_token: true },
        })
      : null,
  ]);
  const destLabel =
    updated?.stops[0]?.consignee.area ||
    updated?.stops[0]?.consignee.company_name ||
    order.zone ||
    "destination";
  await Promise.all([
    sendPushNotifications([driverDevice?.expo_push_token], {
      title: "New trip assigned",
      body: `New trip assigned: ${destLabel}`,
      data: { type: "trip_assigned", tripId },
    }),
    updated
      ? sendPushNotifications([requestorDevice?.expo_push_token], {
          title: "Booking approved",
          body: `Your booking ${updated.ticket_number} has been approved`,
          data: { type: "booking_approved", tripId },
        })
      : Promise.resolve(),
  ]);

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
