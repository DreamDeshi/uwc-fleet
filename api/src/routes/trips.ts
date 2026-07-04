import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { isSerializationConflict, isUniqueViolation } from "../lib/prismaErrors";
import {
  claimPendingTripOrThrow,
  releaseAssignedTrip,
  startAssignedTripForDriver,
  type StartTripOutcome,
} from "../services/tripAssignment";
import { assertStopDeliverable, finalizeTripOnce } from "../services/tripCompletion";
import {
  truckRateSnapshot,
  finalizationRateParams,
  dropZonePoints,
  snapshotStopZonePoints,
  buildPointsByZone,
} from "../services/rateSnapshot";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import {
  calculateDeliveryIncentive,
  getTripDayStart,
  getTripDayEnd,
  groupStopsByDeliveryDay,
  isDocumentationComplete,
  mytDateKey,
} from "../services/incentiveEngine";
import { leaveDateFilter } from "../services/driverLeave";
import { effectiveTruckRates, effectiveZonePoints } from "../services/pendingRates";
import { truckExpiryIssues } from "../services/truckEligibility";
import { PLANT_ORIGIN, zoneCoord, getRoute, type LatLng } from "../lib/geo";
import { loadHolidaySet } from "../lib/holidays";
import { upload } from "../lib/upload";
import { uploadBuffer } from "../lib/cloudinary";
import { sendPushNotifications } from "../lib/pushNotifications";
import { getDispatchMode } from "../lib/settings";
import { autoDispatchTrip } from "../services/dispatchEngine";
import { palletEquivalents } from "../lib/pallets";
import { recordTripEvent } from "../lib/tripHistory";
import { buildTripTimeline } from "../lib/tripTimeline";
import {
  findSchedulingConflicts,
  CONFLICT_STATUSES,
  ASSIGNMENT_CONFLICT_BUFFER_MS,
} from "../services/schedulingConflict";
import { estimateOperatingWindow, formatMinutesToHm } from "../services/operatingWindow";

// ──────────────────────────────────────────────────────────────────────────
// This file is the trip LIFECYCLE end to end — if you read one route file,
// read this one:
//   1. POST /                    requestor books (validation → ticket number →
//                                auto-dispatch fires immediately in auto mode)
//   2. PATCH /:id/approve        admin assigns a driver+truck (all the guards
//                                live here; rates are snapshotted at this moment)
//      PATCH /:id/reject | /:id/assign-external | /:id/cancel — the other exits
//   3. PATCH /:id/status         driver starts the trip, then marks each stop
//                                arrived/delivered; the LAST delivered stop
//                                completes the trip and computes the incentive
//                                (write-once — see the delivered branch)
//   4. POST /:id/stops/:sid/pod  POD photo per stop — the money gate
// Reads (GET /, /:id, /:id/route, /:id/location) are role-scoped: admins see
// everything, drivers and requestors only ever see their own trips.
// ──────────────────────────────────────────────────────────────────────────
const router = Router();
router.use(requireAuth);

const tripInclude = {
  requestor: { select: { id: true, name: true, phone: true } },
  driver: { select: { id: true, name: true, phone: true } },
  truck: true,
  route_type: true,
  stops: { include: { consignee: true }, orderBy: { sequence: "asc" as const } },
  cargo_details: true,
  documents: { orderBy: { uploaded_at: "desc" as const } },
};

// Human-readable destination for notifications — first stop's area/company.
function tripDestinationLabel(trip: {
  stops: { sequence: number; consignee: { area: string | null; company_name: string; zone_code: string } }[];
}): string {
  const first = [...trip.stops].sort((a, b) => a.sequence - b.sequence)[0];
  const c = first?.consignee;
  return c?.area || c?.company_name || c?.zone_code || "destination";
}

// ── Ticket number generation: TKT-YYYYMMDD-NNN, sequential per MYT day ──
// The count-then-create window is racy: two simultaneous bookings can compute
// the same sequence, and ticket_number is @unique. The create route retries on
// that unique violation (attempt bumps the sequence past the winner) instead
// of 500ing the losing booking.
const TICKET_CREATE_RETRIES = 3;

/** "YYYYMMDD" of the MYT day — matches the MYT day-window the count uses. */
export function ticketDatePart(now: Date): string {
  return mytDateKey(now).replace(/-/g, "");
}

async function generateTicketNumber(now: Date, attempt = 0): Promise<string> {
  const dayStart = getTripDayStart(now);
  const dayEnd = getTripDayEnd(now);
  const countToday = await prisma.trip.count({
    where: { created_at: { gte: dayStart, lt: dayEnd } },
  });
  const sequence = String(countToday + 1 + attempt).padStart(3, "0");
  return `TKT-${ticketDatePart(now)}-${sequence}`;
}

// ── POST /trips — requestor submits a booking ───────────────────────────
// Small grace window so a "now" pickup isn't rejected by clock skew between
// the requestor's device and the server.
export const PICKUP_GRACE_MS = 15 * 60 * 1000;

// Exported for unit tests (tests/tripValidation.test.ts).
export const createTripSchema = z.object({
  route_type_id: z.string().min(1),
  pickup_datetime: z.coerce
    .date()
    .refine((d) => d.getTime() >= Date.now() - PICKUP_GRACE_MS, {
      message: "Pickup time is in the past.",
    }),
  is_external: z.boolean().optional(),
  stops: z
    .array(
      z.object({
        consignee_id: z.string().min(1),
        sequence: z.number().int().min(1).optional(),
      })
    )
    .min(1, "At least one stop is required."),
  cargo_details: z
    .array(
      z.object({
        pallet_type: z.string().min(1),
        quantity: z.number().int().min(1),
        cartons: z.number().int().min(0).optional(),
        custom_size: z.string().optional(),
        remark: z.string().optional(),
      })
    )
    .min(1, "At least one cargo line is required."),
});

router.post(
  "/",
  requireRole("requestor", "admin"),
  validateBody(createTripSchema),
  async (req, res, next) => {
    try {
      const { route_type_id, pickup_datetime, is_external, stops, cargo_details } = req.body;

      const routeType = await prisma.routeType.findUnique({ where: { id: route_type_id } });
      if (!routeType) {
        throw new ApiError(400, "ROUTE_TYPE_NOT_FOUND", "Route type does not exist.");
      }

      const consigneeIds = stops.map((s: { consignee_id: string }) => s.consignee_id);
      const foundConsignees = await prisma.consignee.findMany({ where: { id: { in: consigneeIds } } });
      if (foundConsignees.length !== new Set(consigneeIds).size) {
        throw new ApiError(400, "CONSIGNEE_NOT_FOUND", "One or more consignees do not exist.");
      }

      // Cargo bigger than the biggest truck can NEVER be dispatched internally —
      // fail the booking now with a clear error instead of accepting it and
      // letting auto-dispatch fail forever. External-forwarder bookings skip
      // this: outsourcing is exactly what oversized cargo is for.
      if (!is_external) {
        const orderPallets = palletEquivalents(cargo_details);
        const largest = await prisma.truck.aggregate({ _max: { max_pallets: true } });
        const fleetMax = largest._max.max_pallets;
        if (fleetMax !== null && orderPallets > fleetMax) {
          throw new ApiError(
            400,
            "CARGO_EXCEEDS_FLEET",
            `This order is ${orderPallets} pallet-equivalents, but the largest truck holds ${fleetMax}. Split the order or book an external forwarder.`
          );
        }
      }

      // Ticket generation + create, retried on a ticket_number collision: two
      // concurrent bookings can compute the same sequence (count-then-create is
      // not atomic); the loser re-counts with a bumped sequence instead of 500ing.
      let trip!: Prisma.TripGetPayload<{ include: typeof tripInclude }>;
      for (let attempt = 0; ; attempt++) {
        const ticket_number = await generateTicketNumber(new Date(), attempt);
        try {
          trip = await prisma.trip.create({
            data: {
              ticket_number,
              requestor_id: req.user!.id,
              route_type_id,
              pickup_datetime,
              is_external: is_external ?? false,
              stops: {
                create: stops.map((s: { consignee_id: string; sequence?: number }, idx: number) => ({
                  consignee_id: s.consignee_id,
                  sequence: s.sequence ?? idx + 1,
                })),
              },
              cargo_details: { create: cargo_details },
            },
            include: tripInclude,
          });
          break;
        } catch (err) {
          if (isUniqueViolation(err, "ticket_number") && attempt < TICKET_CREATE_RETRIES) {
            continue;
          }
          throw err;
        }
      }

      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.created", table_name: "Trip", record_id: trip.id },
      });
      await recordTripEvent(prisma, { tripId: trip.id, event: "booked", actorId: req.user!.id });

      // Fully-automatic mode: run the dispatch engine immediately so the booking
      // is assigned the moment it's submitted. Best-effort — if no truck fits the
      // trip simply stays pending (the 15-min sweep retries), so a dispatch
      // failure must never break the booking itself.
      let result = trip;
      try {
        if ((await getDispatchMode()) === "auto") {
          const dispatch = await autoDispatchTrip(trip.id);
          if (dispatch.assigned && dispatch.trip) {
            result = dispatch.trip;
          }
        }
      } catch (err) {
        console.error("Auto-dispatch on create failed:", err);
      }

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /trips — role-scoped list, with optional admin search/filters ─────
// All query params are optional. When none are passed the result is identical
// to the unfiltered list; any present params narrow it ON TOP of the role-based
// scoping (admins see all, drivers/requestors only their own).
const TRIP_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "assigned",
  "in_progress",
  "completed",
  "cancelled",
] as const;

router.get("/", async (req, res, next) => {
  try {
    const roleWhere: Prisma.TripWhereInput =
      req.user!.role === "admin"
        ? {}
        : req.user!.role === "driver"
          ? { driver_id: req.user!.id }
          : { requestor_id: req.user!.id };

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const driverId = typeof req.query.driver_id === "string" ? req.query.driver_id : "";
    const zone = typeof req.query.zone === "string" ? req.query.zone : "";
    const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : "";
    const dateTo = typeof req.query.date_to === "string" ? req.query.date_to : "";

    const filters: Prisma.TripWhereInput[] = [];

    if (status && (TRIP_STATUSES as readonly string[]).includes(status)) {
      filters.push({ status: status as Prisma.TripWhereInput["status"] });
    }
    if (driverId) filters.push({ driver_id: driverId });
    // Zone matches any stop whose consignee sits in that zone.
    if (zone) filters.push({ stops: { some: { consignee: { zone_code: zone } } } });

    // Pickup-date range (inclusive). date_to is stretched to end-of-day so the
    // whole "to" date is covered. Invalid dates are ignored rather than erroring.
    const range: Prisma.DateTimeFilter = {};
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo) : null;
    if (from && !isNaN(+from)) range.gte = from;
    if (to && !isNaN(+to)) {
      to.setHours(23, 59, 59, 999);
      range.lte = to;
    }
    if (range.gte || range.lte) filters.push({ pickup_datetime: range });

    // Free-text: ticket number or any stop's consignee company name.
    if (q) {
      filters.push({
        OR: [
          { ticket_number: { contains: q, mode: "insensitive" } },
          { stops: { some: { consignee: { company_name: { contains: q, mode: "insensitive" } } } } },
        ],
      });
    }

    const where: Prisma.TripWhereInput = filters.length
      ? { AND: [roleWhere, ...filters] }
      : roleWhere;

    const trips = await prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: { created_at: "desc" },
    });
    res.json(trips);
  } catch (err) {
    next(err);
  }
});

// ── GET /trips/:id — detail, role-scoped ─────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: req.params.id },
      include: {
        ...tripInclude,
        status_history: { orderBy: { created_at: "asc" as const } },
      },
    });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }

    const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
    const isDriver = req.user!.role === "driver" && trip.driver_id === req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isDriver && !isAdmin) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to view this trip.");
    }

    // Adaptive status timeline derived once, server-side, so all three clients
    // render the same milestones without duplicating the lifecycle logic.
    res.json({ ...trip, timeline: buildTripTimeline(trip) });
  } catch (err) {
    next(err);
  }
});

// ── GET /trips/:id/route — real road polyline (Google Directions, server-side) ──
//
// Keeps GOOGLE_MAPS_API_KEY on the server (never shipped to the app). Routes
// UWC plant → each stop's zone centroid in sequence. Falls back to a straight
// line when Google isn't configured, so the map always renders something.
router.get("/:id/route", async (req, res, next) => {
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: req.params.id },
      include: {
        stops: {
          include: { consignee: { select: { zone_code: true } } },
          orderBy: { sequence: "asc" },
        },
      },
    });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }

    const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
    const isDriver = req.user!.role === "driver" && trip.driver_id === req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isDriver && !isAdmin) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to view this trip.");
    }

    // Each stop's zone centroid, in order, dropping consecutive duplicates so a
    // multi-stop trip within one zone doesn't send a pointless waypoint.
    const stopCoords: LatLng[] = [];
    for (const stop of trip.stops) {
      const c = zoneCoord(stop.consignee.zone_code);
      const prev = stopCoords[stopCoords.length - 1];
      if (!prev || prev.latitude !== c.latitude || prev.longitude !== c.longitude) {
        stopCoords.push(c);
      }
    }

    const destination = stopCoords[stopCoords.length - 1] ?? zoneCoord(null);
    const waypoints = stopCoords.slice(0, -1);
    const route = await getRoute(PLANT_ORIGIN, destination, waypoints);

    res.json(route);
  } catch (err) {
    next(err);
  }
});

// ── GET /trips/:id/location — latest GPS fix for this trip (owner/driver/admin) ──
//
// Lets the requestor track their own delivery without exposing the whole fleet
// (GET /fleet/live is admin-only). Returns null when the driver hasn't pinged.
const LOCATION_STALE_AFTER_MS = 3 * 60 * 1000;

router.get("/:id/location", async (req, res, next) => {
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: req.params.id },
      select: { requestor_id: true, driver_id: true },
    });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }

    const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
    const isDriver = req.user!.role === "driver" && trip.driver_id === req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isDriver && !isAdmin) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to view this trip.");
    }

    const last = await prisma.locationLog.findFirst({
      where: { trip_id: req.params.id },
      orderBy: { recorded_at: "desc" },
      select: { latitude: true, longitude: true, recorded_at: true },
    });
    if (!last) {
      res.json(null);
      return;
    }

    res.json({
      latitude: Number(last.latitude),
      longitude: Number(last.longitude),
      recorded_at: last.recorded_at,
      stale: Date.now() - last.recorded_at.getTime() > LOCATION_STALE_AFTER_MS,
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /trips/:id/approve — admin approves + assigns driver & truck ──
// `force` overrides a scheduling conflict (the admin's "Assign anyway"); it does
// NOT override the physical overload guard.
const approveTripSchema = z.object({
  driver_id: z.string().min(1),
  truck_plate: z.string().min(1),
  force: z.boolean().optional(),
});

/**
 * The assignment guard ladder + atomic claim, shared VERBATIM by the manual
 * approve and the reassign lever (client-approved 3 Jul 2026) so a reassigned
 * trip passes exactly the guards a fresh assignment does. Must run inside a
 * Serializable transaction; the trip must be `pending` when the claim fires
 * (reassign releases it first, in the same transaction).
 *
 * Ladder order (hard = never overridable, force = "Assign anyway" + audit):
 *   1. capacity overload            — hard (physics)
 *   2. insurance/road tax expired   — hard (liability)   permit → force
 *   3. scheduling conflict (±2h)    — force
 *   4. driver mid-delivery          — hard (DRIVER_BUSY, in_progress only)
 *   5. driver on leave that date    — hard
 *   6. operating-window breach      — force
 *   7. atomic claim + rate snapshot — the point of no return
 */
async function assignTripInTx(
  tx: Prisma.TransactionClient,
  opts: {
    trip: { id: string; pickup_datetime: Date };
    driver_id: string;
    truck_plate: string;
    force: boolean;
    actorUserId: string;
    auditAction: string; // "trip.approved" | "trip.reassigned …"
    timelineEvent: "assigned" | "reassigned";
    timelineNote: string;
  }
) {
  const { trip, driver_id, truck_plate, force, actorUserId } = opts;
  const id = trip.id;

  const orderCargo = await tx.cargoDetail.findMany({
              where: { trip_id: id },
              select: { pallet_type: true, quantity: true },
            });
            const truck = await tx.truck.findUnique({
              where: { plate: truck_plate },
              include: {
                trips: {
                  where: { status: { in: ["assigned", "in_progress"] }, id: { not: id } },
                  select: { cargo_details: { select: { pallet_type: true, quantity: true } } },
                },
              },
            });
            if (!truck) {
              throw new ApiError(404, "TRUCK_NOT_FOUND", "Truck not found.");
            }
            const orderPallets = palletEquivalents(orderCargo);
            const currentLoad = truck.trips.reduce(
              (sum, t) => sum + palletEquivalents(t.cargo_details),
              0
            );
            if (currentLoad + orderPallets > truck.max_pallets) {
              throw new ApiError(
                400,
                "TRUCK_OVERLOADED",
                `Truck ${truck_plate} holds ${truck.max_pallets} pallets and already carries ${currentLoad}. This order of ${orderPallets} would total ${currentLoad + orderPallets}.`
              );
            }

            // Roadworthiness gate: expired insurance / road tax is a HARD
            // block (never force-overridable — liability, not judgment); an
            // expired permit warns and may be forced ("Assign anyway",
            // audit-logged below alongside the other overrides).
            const expiry = truckExpiryIssues(truck, new Date());
            if (expiry.hard.length > 0) {
              const docs = expiry.hard
                .map((h) => `${h.doc} expired ${mytDateKey(h.expiry)}`)
                .join("; ");
              throw new ApiError(
                409,
                "TRUCK_UNROADWORTHY",
                `Truck ${truck_plate} cannot be dispatched: ${docs}. Update the document dates on the Trucks page once renewed.`
              );
            }
            if (expiry.permitExpired && !force) {
              throw new ApiError(
                409,
                "TRUCK_PERMIT_EXPIRED",
                `Truck ${truck_plate}'s permit expired ${mytDateKey(expiry.permitExpired)}.`
              );
            }

            // Scheduling-conflict check (roadmap #2) — layered ALONGSIDE the
            // active-trip guard below, with its own code. The same driver or
            // truck already committed to another trip whose pickup is within the
            // buffer of this one is a conflict. Without force → 409 with the
            // clashing trips so the admin can decide; with force → record the
            // override and let the explicitly-overridden trips through.
            const pickup = trip.pickup_datetime;
            const conflictCandidates = await tx.trip.findMany({
              where: {
                id: { not: id },
                status: { in: [...CONFLICT_STATUSES] },
                OR: [{ driver_id }, { truck_plate }],
                pickup_datetime: {
                  gte: new Date(pickup.getTime() - ASSIGNMENT_CONFLICT_BUFFER_MS),
                  lte: new Date(pickup.getTime() + ASSIGNMENT_CONFLICT_BUFFER_MS),
                },
              },
              select: {
                id: true,
                status: true,
                driver_id: true,
                truck_plate: true,
                pickup_datetime: true,
                driver: { select: { name: true } },
              },
            });
            const conflicts = findSchedulingConflicts({
              newTripId: id,
              driverId: driver_id,
              truckPlate: truck_plate,
              pickupDateTime: pickup,
              candidates: conflictCandidates,
            });
            if (conflicts.length > 0 && !force) {
              throw new ApiError(
                409,
                "SCHEDULING_CONFLICT",
                "This driver or truck has another trip scheduled within the conflict window.",
                { conflicts }
              );
            }

            // One-active-trip-per-driver (core model): a driver may HOLD several
            // scheduled (assigned-but-not-started) trips, but may be OUT on only
            // ONE in_progress trip at a time. So the hard block here is solely an
            // in_progress trip — scheduled overlaps are handled by the
            // SCHEDULING_CONFLICT layer above (overridable with force). This guard
            // is never force-overridable: you cannot stack work onto a driver who
            // is physically mid-delivery. Checked inside the txn so two concurrent
            // approves can't both flip the same driver to a second active trip.
            const driverInProgress = await tx.trip.count({
              where: {
                driver_id,
                status: "in_progress",
                id: { not: id },
              },
            });
            if (driverInProgress > 0) {
              throw new ApiError(
                409,
                "DRIVER_BUSY",
                "This driver is currently out on an in-progress trip."
              );
            }

            // Leave guard (tracker #4): like DRIVER_BUSY, never force-overridable —
            // a driver on leave for the trip's PICKUP date is physically unavailable.
            // Date-scoped, so the same driver stays assignable for other dates.
            const leave = await tx.driverLeave.findFirst({
              where: { driver_id, ...leaveDateFilter(mytDateKey(trip.pickup_datetime)) },
            });
            if (leave) {
              throw new ApiError(
                409,
                "DRIVER_ON_LEAVE",
                `This driver is on leave for the pickup date (${leave.start_date}${
                  leave.end_date !== leave.start_date ? ` to ${leave.end_date}` : ""
                }).`
              );
            }

            // Operating-window cutoff (Phase 3): WARN (don't hard-block) when the
            // run's estimated completion would fall past the truck's operating
            // window, or the pickup is outside it. Like the scheduling conflict
            // this is overridable with force ("Assign anyway") and writes an audit
            // row; the physical overload guard remains the only non-overridable
            // block. pickup_datetime is never mutated.
            // Per-stop zone points scale the drive-leg estimate (distance
            // proxy); a zone without a rate row falls back to the flat figure.
            const windowStops = await tx.tripStop.findMany({
              where: { trip_id: id },
              orderBy: { sequence: "asc" },
              select: { consignee: { select: { zone_code: true } } },
            });
            const windowZones = windowStops.map((s) => s.consignee.zone_code);
            const windowRates = await tx.destinationRate.findMany({
              where: { zone_code: { in: [...new Set(windowZones)] } },
            });
            // Points effective NOW (a staged next-day edit is invisible) — the
            // same values the assignment snapshot will freeze below.
            const windowPoints = new Map(
              windowRates.map((r) => [r.zone_code, effectiveZonePoints(r, new Date())])
            );
            const windowEst = estimateOperatingWindow({
              pickupDateTime: trip.pickup_datetime,
              stopCount: windowStops.length,
              stopPoints: windowZones.map((z) => windowPoints.get(z) ?? null),
              windowStart: truck.operating_hours_start,
              windowEnd: truck.operating_hours_end,
            });
            if (windowEst.exceedsWindow && !force) {
              throw new ApiError(
                409,
                "OPERATING_WINDOW",
                windowEst.reason === "pickup_outside_window"
                  ? `Pickup is outside the ${formatMinutesToHm(windowEst.windowStartMin)}–${formatMinutesToHm(windowEst.windowEndMin)} operating window.`
                  : `Est. completion ${windowEst.completionLabel} is past the ${formatMinutesToHm(windowEst.windowEndMin)} operating window.`,
                {
                  estimated_completion: windowEst.completionLabel,
                  window_end: formatMinutesToHm(windowEst.windowEndMin),
                  reason: windowEst.reason,
                }
              );
            }

            // Atomic claim: throws 409 CONCURRENT_ASSIGNMENT if no longer pending.
            // Clear any auto-dispatch-failed flag — a manual assignment resolves
            // the "needs attention" state (Phase 2 self-clearing). The claim also
            // freezes the truck's rates onto the trip (rate lock): finalization
            // pays at these values even if an admin edits the rates mid-flight.
            // The rates frozen are those EFFECTIVE right now — a staged rate
            // edit is invisible until its next-MYT-day cutoff (client rule).
            await claimPendingTripOrThrow(tx, id, {
              driver_id,
              truck_plate,
              auto_dispatch_failed: false,
              ...truckRateSnapshot(effectiveTruckRates(truck, new Date())),
            });
            await snapshotStopZonePoints(tx, id);

            await tx.auditLog.create({
              data: { user_id: actorUserId, action: opts.auditAction, table_name: "Trip", record_id: id },
            });
            if (force && conflicts.length > 0) {
              await tx.auditLog.create({
                data: {
                  user_id: actorUserId,
                  action: "assignment_conflict_override",
                  table_name: "Trip",
                  record_id: `${id}; conflicts: ${conflicts.map((c) => c.tripId).join(", ")}`,
                },
              });
            }
            // Audit a forced override of the operating-window warning (Phase 3).
            if (force && windowEst.exceedsWindow) {
              await tx.auditLog.create({
                data: {
                  user_id: actorUserId,
                  action: "operating_window_override",
                  table_name: "Trip",
                  record_id: `${id}; est_completion ${windowEst.completionLabel} (${windowEst.reason})`,
                },
              });
            }
            // Audit a forced override of an expired permit (roadworthiness gate).
            if (force && expiry.permitExpired) {
              await tx.auditLog.create({
                data: {
                  user_id: actorUserId,
                  action: "permit_expiry_override",
                  table_name: "Trip",
                  record_id: `${id}; ${truck_plate} permit expired ${mytDateKey(expiry.permitExpired)}`,
                },
              });
            }
            await recordTripEvent(tx, {
              tripId: id,
              event: opts.timelineEvent,
              actorId: actorUserId,
              note: opts.timelineNote,
            });

            return tx.trip.findUnique({ where: { id }, include: tripInclude });
}

router.patch(
  "/:id/approve",
  requireRole("admin"),
  validateBody(approveTripSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { driver_id, truck_plate, force } = req.body;

      const trip = await prisma.trip.findUnique({ where: { id } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.status !== "pending") {
        throw new ApiError(400, "INVALID_STATUS", "Only pending trips can be approved.");
      }

      const driver = await prisma.user.findUnique({ where: { id: driver_id } });
      if (!driver || driver.role !== "driver") {
        throw new ApiError(400, "DRIVER_NOT_FOUND", "Driver does not exist.");
      }
      if (driver.assigned_truck_plate !== truck_plate) {
        throw new ApiError(
          400,
          "DRIVER_TRUCK_MISMATCH",
          "This driver is not assigned to the given truck."
        );
      }

      // Guard ladder + atomic claim (see assignTripInTx above), under
      // Serializable isolation so two admins (or the background sweep) can't
      // double-assign a driver/truck or slip past the capacity limit via a
      // check-then-write race (spec AUTO DISPATCH LOGIC §4.2). Concurrent
      // conflicting writers abort with P2034 → 409.
      let updated;
      try {
        updated = await prisma.$transaction(
          (tx) =>
            assignTripInTx(tx, {
              trip,
              driver_id,
              truck_plate,
              force: !!force,
              actorUserId: req.user!.id,
              auditAction: "trip.approved",
              timelineEvent: "assigned",
              timelineNote: `${driver.name} · ${truck_plate}`,
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (err) {
        if (isSerializationConflict(err)) {
          throw new ApiError(
            409,
            "CONCURRENT_ASSIGNMENT",
            "This booking is being assigned by someone else. Please try again."
          );
        }
        throw err;
      }
      if (!updated) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }

      // Notify the driver (new assignment) and the requestor (approved). Tokens
      // are fetched fresh; sends are best-effort and never block the response.
      const [driverDevice, requestorDevice] = await Promise.all([
        prisma.user.findUnique({ where: { id: driver_id }, select: { expo_push_token: true } }),
        prisma.user.findUnique({ where: { id: updated.requestor_id }, select: { expo_push_token: true } }),
      ]);
      const destination = tripDestinationLabel(updated);
      await Promise.all([
        sendPushNotifications([driverDevice?.expo_push_token], {
          title: "New trip assigned",
          body: `New trip assigned: ${destination}`,
          data: { type: "trip_assigned", tripId: updated.id },
        }),
        sendPushNotifications([requestorDevice?.expo_push_token], {
          title: "Booking approved",
          body: `Your booking ${updated.ticket_number} has been approved`,
          data: { type: "booking_approved", tripId: updated.id },
        }),
      ]);

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/unassign — pull the driver off an ASSIGNED trip ──
// Client-approved ops lever (Q3, 3 Jul 2026): admin may interrupt an assigned
// (not-yet-started) trip. The trip returns to pending and re-enters the normal
// flow — the pending sweep re-alerts admins and, in auto mode, retries
// auto-dispatch. in_progress trips are OUT OF SCOPE (that's the separate
// cancel-in-progress question): the status-guarded release never matches them.
const unassignTripSchema = z.object({ reason: z.string().max(500).optional() });

router.patch(
  "/:id/unassign",
  requireRole("admin"),
  validateBody(unassignTripSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const trip = await prisma.trip.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          ticket_number: true,
          driver_id: true,
          truck_plate: true,
          driver: { select: { name: true, expo_push_token: true } },
        },
      });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.status !== "assigned") {
        throw new ApiError(
          400,
          "INVALID_STATUS",
          "Only assigned (not yet started) trips can be unassigned."
        );
      }

      const freedPair = `${trip.driver?.name ?? "driver"} · ${trip.truck_plate ?? "—"}`;
      await prisma.$transaction(async (tx) => {
        // Status-guarded CAS: a driver tapping "Start Trip" concurrently wins —
        // an in_progress trip must never be silently pulled back to pending.
        const released = await releaseAssignedTrip(tx, id);
        if (!released) {
          throw new ApiError(
            409,
            "TRIP_NOT_UNASSIGNABLE",
            "This trip just changed state (the driver may have started it). Refresh and try again."
          );
        }
        // Drop the per-stop zone-point snapshots too — they belong to the old
        // assignment; the next assignment re-takes them.
        await tx.tripStop.updateMany({ where: { trip_id: id }, data: { zone_points: null } });
        await tx.auditLog.create({
          data: {
            user_id: req.user!.id,
            action: `trip.unassigned (freed ${freedPair})${reason ? ` — ${reason}` : ""}`,
            table_name: "Trip",
            record_id: id,
          },
        });
        await recordTripEvent(tx, {
          tripId: id,
          event: "unassigned",
          actorId: req.user!.id,
          note: `was ${freedPair}${reason ? ` — ${reason}` : ""}`,
        });
      });

      // Tell the freed driver the trip is no longer theirs (best-effort).
      await sendPushNotifications([trip.driver?.expo_push_token], {
        title: "Trip removed",
        body: `Trip ${trip.ticket_number} has been removed from your assignments`,
        data: { type: "trip_unassigned", tripId: id },
      });

      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/reassign — move an ASSIGNED trip to another driver ──
// Client-approved ops lever (Q3, 3 Jul 2026). Release + full re-assignment in
// ONE Serializable transaction: the new driver/truck passes the SAME guard
// ladder as a fresh assignment (capacity, roadworthiness, conflict, busy,
// leave, operating window — see assignTripInTx) and the rate snapshot is
// RE-TAKEN for the new truck at this moment. If any guard rejects, the whole
// transaction rolls back and the trip stays with the old driver.
const reassignTripSchema = z.object({
  driver_id: z.string().min(1),
  truck_plate: z.string().min(1),
  force: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

router.patch(
  "/:id/reassign",
  requireRole("admin"),
  validateBody(reassignTripSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { driver_id, truck_plate, force, reason } = req.body;

      const trip = await prisma.trip.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          ticket_number: true,
          pickup_datetime: true,
          driver_id: true,
          truck_plate: true,
          driver: { select: { name: true, expo_push_token: true } },
        },
      });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.status !== "assigned") {
        throw new ApiError(
          400,
          "INVALID_STATUS",
          "Only assigned (not yet started) trips can be reassigned."
        );
      }
      if (trip.driver_id === driver_id && trip.truck_plate === truck_plate) {
        throw new ApiError(400, "SAME_ASSIGNMENT", "The trip is already assigned to this driver and truck.");
      }

      const driver = await prisma.user.findUnique({ where: { id: driver_id } });
      if (!driver || driver.role !== "driver") {
        throw new ApiError(400, "DRIVER_NOT_FOUND", "Driver does not exist.");
      }
      if (driver.assigned_truck_plate !== truck_plate) {
        throw new ApiError(
          400,
          "DRIVER_TRUCK_MISMATCH",
          "This driver is not assigned to the given truck."
        );
      }

      const oldPair = `${trip.driver?.name ?? "driver"} · ${trip.truck_plate ?? "—"}`;
      let updated;
      try {
        updated = await prisma.$transaction(
          async (tx) => {
            // Release first (status-guarded CAS — loses to a concurrent Start
            // Trip), then run the untouched assignment ladder + claim.
            const released = await releaseAssignedTrip(tx, id);
            if (!released) {
              throw new ApiError(
                409,
                "TRIP_NOT_UNASSIGNABLE",
                "This trip just changed state (the driver may have started it). Refresh and try again."
              );
            }
            return assignTripInTx(tx, {
              trip,
              driver_id,
              truck_plate,
              force: !!force,
              actorUserId: req.user!.id,
              auditAction: `trip.reassigned ${oldPair} → ${driver.name} · ${truck_plate}${reason ? ` — ${reason}` : ""}`,
              timelineEvent: "reassigned",
              timelineNote: `${oldPair} → ${driver.name} · ${truck_plate}`,
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (err) {
        if (isSerializationConflict(err)) {
          throw new ApiError(
            409,
            "CONCURRENT_ASSIGNMENT",
            "This trip is being modified by someone else. Please try again."
          );
        }
        throw err;
      }
      if (!updated) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }

      // Notify both drivers (best-effort, never blocks the response). The
      // requestor's booking stays approved throughout — no requestor ping.
      const newDriverDevice = await prisma.user.findUnique({
        where: { id: driver_id },
        select: { expo_push_token: true },
      });
      const destination = tripDestinationLabel(updated);
      await Promise.all([
        sendPushNotifications([trip.driver?.expo_push_token], {
          title: "Trip removed",
          body: `Trip ${trip.ticket_number} has been removed from your assignments`,
          data: { type: "trip_unassigned", tripId: id },
        }),
        sendPushNotifications([newDriverDevice?.expo_push_token], {
          title: "New trip assigned",
          body: `New trip assigned: ${destination}`,
          data: { type: "trip_assigned", tripId: id },
        }),
      ]);

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/reject — admin rejects a pending booking ──
const rejectTripSchema = z.object({ reason: z.string().max(500).optional() });

router.patch(
  "/:id/reject",
  requireRole("admin"),
  validateBody(rejectTripSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const trip = await prisma.trip.findUnique({ where: { id } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.status !== "pending") {
        throw new ApiError(400, "INVALID_STATUS", "Only pending trips can be rejected.");
      }

      const { reason } = req.body;
      const updated = await prisma.trip.update({
        where: { id },
        // Leaving pending clears the needs-attention flag (Phase 2 self-clearing).
        data: { status: "rejected", rejection_reason: reason ?? null, auto_dispatch_failed: false },
        include: tripInclude,
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.rejected", table_name: "Trip", record_id: id },
      });
      await recordTripEvent(prisma, {
        tripId: id,
        event: "rejected",
        actorId: req.user!.id,
        note: reason ?? null,
      });

      const requestorDevice = await prisma.user.findUnique({
        where: { id: updated.requestor_id },
        select: { expo_push_token: true },
      });
      const reasonSuffix = reason ? `: ${reason}` : "";
      await sendPushNotifications([requestorDevice?.expo_push_token], {
        title: "Booking rejected",
        body: `Your booking ${updated.ticket_number} was rejected${reasonSuffix}`,
        data: { type: "booking_rejected", tripId: updated.id },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/assign-external — admin outsources to a forwarder ──
const externalSchema = z.object({
  company_name: z.string().min(1, "Company name is required."),
  booking_date: z.coerce.date(),
  rate: z.number().nonnegative(),
  cargo_size: z.string().min(1, "Cargo size is required."),
});

router.patch(
  "/:id/assign-external",
  requireRole("admin"),
  validateBody(externalSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { company_name, booking_date, rate, cargo_size } = req.body;

      const trip = await prisma.trip.findUnique({ where: { id } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.status !== "pending") {
        throw new ApiError(400, "INVALID_STATUS", "Only pending trips can be assigned.");
      }

      await prisma.externalForwarder.upsert({
        where: { trip_id: id },
        create: { trip_id: id, company_name, booking_date, rate, cargo_size },
        update: { company_name, booking_date, rate, cargo_size },
      });
      const updated = await prisma.trip.update({
        where: { id },
        // Outsourcing resolves the booking → clear the needs-attention flag.
        data: { status: "assigned", is_external: true, auto_dispatch_failed: false },
        include: tripInclude,
      });
      await prisma.auditLog.create({
        data: {
          user_id: req.user!.id,
          action: "trip.assigned_external",
          table_name: "Trip",
          record_id: id,
        },
      });
      await recordTripEvent(prisma, {
        tripId: id,
        event: "assigned_external",
        actorId: req.user!.id,
        note: company_name,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/cancel — requestor (owner) or admin cancels a booking ──
// Only while still pending/approved — once a driver is assigned or rolling,
// cancellation must be coordinated by an admin (out of scope for the app).
router.patch("/:id/cancel", async (req, res, next) => {
  try {
    const { id } = req.params;
    const trip = await prisma.trip.findUnique({ where: { id } });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }

    const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isAdmin) {
      throw new ApiError(403, "FORBIDDEN", "You cannot cancel this booking.");
    }
    if (trip.status !== "pending" && trip.status !== "approved") {
      throw new ApiError(
        400,
        "INVALID_STATUS",
        "Only bookings that have not been assigned yet can be cancelled."
      );
    }

    const updated = await prisma.trip.update({
      where: { id },
      // Cancelling clears the needs-attention flag (Phase 2 self-clearing).
      data: { status: "cancelled", auto_dispatch_failed: false },
      include: tripInclude,
    });
    await prisma.auditLog.create({
      data: { user_id: req.user!.id, action: "trip.cancelled", table_name: "Trip", record_id: id },
    });
    await recordTripEvent(prisma, { tripId: id, event: "cancelled", actorId: req.user!.id });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /trips/:id/stops/:stopId/docs — driver confirms a stop's documents ──
// Historically the DO confirmation was a bare checkbox (the photo upload came
// later); today the POD photo is REQUIRED first — do_uploaded can only be set
// once pod_photo exists (guard below), and the POD upload route flips it
// automatically anyway. The K2 customs form remains a checkbox acknowledgement.
// These flags gate the "delivered" action via isDocumentationComplete().
const stopDocsSchema = z.object({
  do_uploaded: z.boolean().optional(),
  k2_form_ack: z.boolean().optional(),
});

router.patch(
  "/:id/stops/:stopId/docs",
  requireRole("driver"),
  validateBody(stopDocsSchema),
  async (req, res, next) => {
    try {
      const { id, stopId } = req.params;
      const { do_uploaded, k2_form_ack } = req.body;

      const trip = await prisma.trip.findUnique({ where: { id }, include: { stops: true } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.driver_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
      }
      const stop = trip.stops.find((s) => s.id === stopId);
      if (!stop) {
        throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
      }

      // do_uploaded may only assert a POD photo that actually exists — it is
      // flipped by the photo upload; allowing it bare would let the delivery
      // gate (and the incentive behind it) be satisfied with no photo at all.
      if (do_uploaded === true && !stop.pod_photo) {
        throw new ApiError(
          400,
          "POD_PHOTO_REQUIRED",
          "Upload the POD photo first — the DO flag cannot be set without it."
        );
      }

      await prisma.tripStop.update({
        where: { id: stopId },
        data: {
          ...(do_uploaded !== undefined ? { do_uploaded } : {}),
          ...(k2_form_ack !== undefined ? { k2_form_ack } : {}),
        },
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "stop.docs_updated", table_name: "TripStop", record_id: stopId },
      });

      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /trips/:id/stops/:stopId/pod — driver uploads the POD photo ──
//
// Multipart upload (field name "photo"). The mobile app captures with the
// camera (gallery fallback) and compresses to ≤500KB before sending. We push
// the buffer to Cloudinary, store the URL on the stop, and flip do_uploaded so
// the "Delivered" gate (isDocumentationComplete) is satisfied.
router.post(
  "/:id/stops/:stopId/pod",
  requireRole("driver"),
  upload.single("photo"),
  async (req, res, next) => {
    try {
      const { id, stopId } = req.params;

      if (!req.file) {
        throw new ApiError(400, "NO_FILE", "A photo file is required (field name 'photo').");
      }

      const trip = await prisma.trip.findUnique({ where: { id }, include: { stops: true } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.driver_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
      }
      const stop = trip.stops.find((s) => s.id === stopId);
      if (!stop) {
        throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
      }

      const url = await uploadBuffer(req.file.buffer, "uwc/pod", {
        publicId: `${trip.ticket_number}-stop-${stop.sequence}`,
      });

      await prisma.tripStop.update({
        where: { id: stopId },
        data: { pod_photo: url, do_uploaded: true },
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "stop.pod_uploaded", table_name: "TripStop", record_id: stopId },
      });

      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      res.status(201).json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /trips/:id/documents — requestor/admin uploads a DO or invoice ──
//
// Multipart upload (field name "file") plus a "type" field. Accepts images or
// PDFs (resource_type "auto" lets Cloudinary store either). The uploaded docs
// surface on the requestor's BookingDetail screen.
const documentTypes = ["do_photo", "k2_form", "other"] as const;

router.post(
  "/:id/documents",
  requireRole("requestor", "admin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!req.file) {
        throw new ApiError(400, "NO_FILE", "A file is required (field name 'file').");
      }

      const rawType = typeof req.body.type === "string" ? req.body.type : "other";
      const type = (documentTypes as readonly string[]).includes(rawType)
        ? (rawType as (typeof documentTypes)[number])
        : "other";

      const trip = await prisma.trip.findUnique({ where: { id } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
      const isAdmin = req.user!.role === "admin";
      if (!isOwner && !isAdmin) {
        throw new ApiError(403, "FORBIDDEN", "You do not have permission to add documents to this trip.");
      }

      const url = await uploadBuffer(req.file.buffer, "uwc/documents", { resourceType: "auto" });

      await prisma.tripDocument.create({
        data: { trip_id: id, type, file_url: url },
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.document_uploaded", table_name: "TripDocument", record_id: id },
      });

      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      res.status(201).json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/status — driver updates status (start/arrived/delivered) ──
const statusUpdateSchema = z.object({
  action: z.enum(["start", "arrived", "delivered"]),
  stop_id: z.string().optional(),
});

router.patch(
  "/:id/status",
  requireRole("driver"),
  validateBody(statusUpdateSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { action, stop_id } = req.body;

      const trip = await prisma.trip.findUnique({
        where: { id },
        include: { stops: { orderBy: { sequence: "asc" } }, truck: true },
      });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.driver_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
      }

      if (action === "start") {
        if (trip.status !== "assigned") {
          throw new ApiError(400, "INVALID_STATUS", "Only assigned trips can be started.");
        }
        // One-active-trip enforced at the START transition (not only at
        // assignment): holding several assigned trips is fine, being OUT on
        // two is not — a second concurrent in_progress trip is exactly the
        // state that double-pays the finalize day-ledger. The CAS carries the
        // whole guard in its where; Serializable isolation covers the
        // residual simultaneous-snapshot race (P2034 → 409), same pattern as
        // the approve transaction.
        let outcome: StartTripOutcome;
        try {
          outcome = await prisma.$transaction(
            async (tx) => {
              const result = await startAssignedTripForDriver(tx, id, req.user!.id);
              if (result !== "started") return result;
              await tx.auditLog.create({
                data: { user_id: req.user!.id, action: "trip.started", table_name: "Trip", record_id: id },
              });
              await recordTripEvent(tx, { tripId: id, event: "started", actorId: req.user!.id });
              return result;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          );
        } catch (err) {
          if (isSerializationConflict(err)) {
            throw new ApiError(
              409,
              "TRIP_STATE_CHANGED",
              "This trip was updated by someone else just now. Refresh and try again."
            );
          }
          throw err;
        }
        if (outcome === "driver_busy") {
          throw new ApiError(
            409,
            "DRIVER_ALREADY_ON_TRIP",
            "You already have a trip in progress. Complete it before starting another."
          );
        }
        if (outcome === "state_changed") {
          throw new ApiError(
            409,
            "TRIP_STATE_CHANGED",
            "This trip just changed state. Refresh and try again."
          );
        }
        const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
        res.json(updated);
        return;
      }

      // arrived / delivered both act on a specific stop. No stop_id → default
      // to the first not-yet-delivered stop, so single-stop trips don't need
      // to name it.
      const stop = stop_id
        ? trip.stops.find((s) => s.id === stop_id)
        : trip.stops.find((s) => s.status !== "delivered");
      if (!stop) {
        throw new ApiError(400, "STOP_NOT_FOUND", "No matching stop found for this trip.");
      }

      if (action === "arrived") {
        if (stop.status !== "pending") {
          throw new ApiError(400, "INVALID_STATUS", "This stop has already been marked arrived.");
        }
        await prisma.tripStop.update({
          where: { id: stop.id },
          data: { status: "arrived", arrived_at: new Date() },
        });
        await prisma.auditLog.create({
          data: { user_id: req.user!.id, action: "stop.arrived", table_name: "TripStop", record_id: stop.id },
        });
        await recordTripEvent(prisma, {
          tripId: id,
          event: "stop_arrived",
          stopId: stop.id,
          actorId: req.user!.id,
        });
        const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
        res.json(updated);
        return;
      }

      // action === "delivered"
      // A stop can be delivered only while the trip is out, and only once —
      // re-posting "delivered" on a completed trip would otherwise re-run the
      // finalization below and overwrite incentive_earned at whatever the
      // rates/day-ledger are NOW (the audit's re-finalization pay hole).
      assertStopDeliverable(trip, stop);
      const consigneeForGate = await prisma.consignee.findUnique({ where: { id: stop.consignee_id } });
      if (!consigneeForGate) {
        throw new ApiError(400, "CONSIGNEE_NOT_FOUND", "Consignee for this stop no longer exists.");
      }
      if (!isDocumentationComplete(stop, consigneeForGate.zone_code)) {
        throw new ApiError(
          400,
          "DOCUMENTATION_INCOMPLETE",
          "DO photo (and K2 form ack for K2 destinations) must be completed before marking delivered."
        );
      }

      await prisma.tripStop.update({
        where: { id: stop.id },
        data: { status: "delivered", delivered_at: new Date() },
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "stop.delivered", table_name: "TripStop", record_id: stop.id },
      });
      await recordTripEvent(prisma, {
        tripId: id,
        event: "stop_delivered",
        stopId: stop.id,
        actorId: req.user!.id,
      });

      const remainingStops = await prisma.tripStop.count({
        where: { trip_id: id, status: { not: "delivered" } },
      });

      if (remainingStops > 0) {
        // More stops to go — the trip stays in_progress and no money moves yet.
        const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
        res.json(updated);
        return;
      }

      // Last stop delivered — finalize the trip and run the incentive engine.
      if (!trip.truck) {
        throw new ApiError(400, "TRUCK_NOT_ASSIGNED", "This trip has no truck assigned.");
      }

      // This trip's delivered drops, in delivered order, each with its zone's
      // full destination points. Scored stop-by-stop (per-zone-per-day), summed.
      const thisTripStops = await prisma.tripStop.findMany({
        where: { trip_id: id },
        orderBy: { delivered_at: "asc" },
        include: { consignee: { select: { zone_code: true } } },
      });
      // Rate lock: points and claim rates come from the ASSIGNMENT-time
      // snapshot (TripStop.zone_points / the trip's rate fields); the live
      // lookups below are only the fallback for trips assigned before the
      // rate-lock migration or rows seeded directly into `assigned`. The
      // fallback also respects the next-day cutoff: points effective NOW, not
      // a staged edit.
      const zoneCodes = [...new Set(thisTripStops.map((s) => s.consignee.zone_code))];
      const rateRows = await prisma.destinationRate.findMany({
        where: { zone_code: { in: zoneCodes } },
        select: {
          zone_code: true,
          location_name: true,
          points: true,
          pending_points: true,
          pending_points_effective: true,
        },
      });
      const pointsByZone = buildPointsByZone(
        rateRows.map((r) => ({ ...r, points: effectiveZonePoints(r, new Date()) }))
      );

      // The incentive day keys on DELIVERY confirm time, not pickup (client
      // rule, Mr. Teh 3 Jul 2026: "points calculate on delivery confirm time;
      // after 12am points refresh for next day"). A trip picked up 23:30 and
      // delivered 00:30 counts for the DELIVERY day's ledger and deduction.
      // Stops are grouped per MYT delivery day (normally one group; a trip
      // straddling midnight splits, and each day scores against its own
      // ledger with its own deduction + confirm-time rate tier).
      const dayGroups = groupStopsByDeliveryDay(thisTripStops, new Date());
      // Admin-managed calendar (PublicHoliday table) — loaded here so the
      // engine stays pure. The weekday/off-peak decision runs exactly once,
      // at this finalization; later calendar edits never touch stored pay
      // (write-once finalizeTripOnce below).
      const publicHolidays = await loadHolidaySet();
      const truckRates = finalizationRateParams({
        entitled_claim_weekday: trip.entitled_claim_weekday,
        entitled_claim_offpeak: trip.entitled_claim_offpeak,
        daily_deduction_points: trip.daily_deduction_points,
        // The live fallback (pre-snapshot legacy trips only) also respects the
        // next-day cutoff: pay at the rates effective NOW, not a staged edit.
        truck: effectiveTruckRates(trip.truck, new Date()),
      });

      let incentiveThisTrip = 0;
      for (const group of dayGroups) {
        // Per-day ledger: drops this driver already DELIVERED on this group's
        // MYT day, on OTHER (completed) trips — regardless of when those trips
        // were picked up. A stop whose zone is already on the ledger scores
        // 1 point; the day's FIRST drop is the one the daily deduction lands
        // on, so isFirstDeliveredDropOfDay is true only when the ledger is
        // empty. (One-active-trip serialises a driver's deliveries, so every
        // earlier drop today belongs to an already-completed trip.)
        const priorStopsToday = await prisma.tripStop.findMany({
          where: {
            status: "delivered",
            delivered_at: { gte: group.dayStart, lt: group.dayEnd },
            trip: { driver_id: req.user!.id, status: "completed", id: { not: id } },
          },
          select: { consignee: { select: { zone_code: true } } },
        });
        const zonesDeliveredEarlierToday = priorStopsToday.map((s) => s.consignee.zone_code);
        const isFirstDeliveredDropOfDay = zonesDeliveredEarlierToday.length === 0;

        const drops = group.stops.map((s) => ({
          zoneCode: s.consignee.zone_code,
          zonePoints: dropZonePoints(s, pointsByZone.get(s.consignee.zone_code), s.consignee.zone_code),
        }));

        const incentive = calculateDeliveryIncentive({
          rateDateTime: group.anchor,
          drops,
          zonesDeliveredEarlierToday,
          isFirstDeliveredDropOfDay,
          publicHolidays,
          truck: truckRates,
        });
        incentiveThisTrip += incentive.incentiveThisTrip;
      }
      // Guard against float dust from summing per-group marginals.
      incentiveThisTrip = Math.round(incentiveThisTrip * 100) / 100;

      // Store the MARGINAL (per-trip) incentive, not the running day total,
      // so the endpoints that SUM incentive_earned across a day are correct.
      // Write-once compare-and-set: a concurrent (or repeated) finalization
      // loses the guard and must never overwrite the stored pay.
      const finalized = await finalizeTripOnce(prisma, id, incentiveThisTrip);
      if (!finalized) {
        throw new ApiError(
          409,
          "TRIP_ALREADY_FINALIZED",
          "This trip has already been completed and its incentive finalized."
        );
      }
      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });

      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.completed", table_name: "Trip", record_id: id },
      });
      await recordTripEvent(prisma, { tripId: id, event: "completed", actorId: req.user!.id });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
