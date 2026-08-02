import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { normalizeStopSequences } from "../lib/stopSequence";
import {
  isSerializationConflict,
  isUniqueViolation,
  isUniqueViolationOnField,
} from "../lib/prismaErrors";
import {
  claimPendingTripOrThrow,
  releaseAssignedTrip,
  startAssignedTripForDriver,
  rejectPendingTrip,
  cancelBookedTrip,
  abortActiveTrip,
  outsourcePendingTrip,
  type StartTripOutcome,
} from "../services/tripAssignment";
import {
  assertStopArrivable,
  assertStopDeliverable,
  assertIncentiveApprovable,
  collectFinalizeBreakdown,
  proposeTripIncentiveOnce,
  approveTripIncentiveOnce,
  type FinalizedGroup,
} from "../services/tripCompletion";
import {
  truckRateSnapshot,
  finalizationRateParams,
  dropZonePoints,
  dropZoneCode,
  snapshotStopZonePoints,
  buildPointsByZone,
} from "../services/rateSnapshot";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { mytDayBoundsForKey } from "../lib/myt";
import {
  TRIP_LIST_ORDER,
  buildTripPage,
  parseTripListQuery,
  tripKeysetWhere,
} from "../lib/tripCursor";
import {
  calculateDeliveryIncentive,
  getTripDayStart,
  getTripDayEnd,
  groupStopsByDeliveryDay,
  isDocumentationComplete,
  mytDateKey,
  scoreDrops,
} from "../services/incentiveEngine";
import { leaveDateFilter } from "../services/driverLeave";
import { priorDeliveredDropsWhere } from "../services/dayLedger";
import { SETTLED_UNDELIVERED_WHERE, isStopSettled, hasOpenException, ADJUDICATED_UNDELIVERED_WHERE, isStopAdjudicated } from "../services/undeliveredPay";
import { sha256Hex } from "../lib/exceptionFingerprint";
import { changeRequestsEnabled } from "../lib/featureFlags";
import { TRIP_INCLUDE } from "../lib/tripInclude";
import { proposeDeliveredStopsIncentive } from "../services/tripFinalize";
import { effectiveTruckRates, effectiveZonePoints } from "../services/pendingRates";
import { truckExpiryIssues } from "../services/truckEligibility";
import { getRoute } from "../services/routeLegs";
import { loadHolidaySet } from "../lib/holidays";
import { upload, assertMimetype, IMAGE_MIMETYPES, DOCUMENT_MIMETYPES } from "../lib/upload";
import { uploadBuffer } from "../lib/cloudinary";
import { lockTripRow } from "../lib/tripLock";
import { testHook } from "../lib/testHooks";
import { signTripResponse } from "../lib/podPhotos";
import { resolveFleetFix } from "../lib/gpsPosition";
import { sendPushNotifications } from "../lib/pushNotifications";
import { signTrackingToken } from "../lib/trackingToken";
import { getDispatchMode } from "../lib/settings";
import { autoDispatchTrip } from "../services/dispatchEngine";
import {
  palletEquivalents,
  BOOKABLE_CARGO_TYPES,
  CARGO_PALLET_TYPES,
  DEPRECATED_PALLET_SIZES,
  normalizePalletType,
  canonicalCargoSize,
  isValidDimension,
} from "../lib/pallets";

// Q10: canonicalise a cargo line's stored size. A crate/rack/custom line with
// structured dimensions gets its `custom_size` set to the canonical "W × L ft"
// (derived from width_ft/length_ft). A legacy free-text custom line (no dims) is
// left untouched, so an unrelated edit never rewrites it.
function withCanonicalCargoSize<
  T extends { width_ft?: number | null; length_ft?: number | null; custom_size?: string | null }
>(line: T): T {
  if (isValidDimension(line.width_ft) && isValidDimension(line.length_ft)) {
    return { ...line, custom_size: canonicalCargoSize(line.width_ft, line.length_ft) };
  }
  return line;
}
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

// POD photos are private (authenticated Cloudinary assets). This wraps res.json
// so EVERY trip payload leaving this router serves POD photos as freshly-signed,
// unguessable URLs (lib/podPhotos.ts) instead of the stored authenticated URL —
// one choke point, so no handler can forget and no future route can leak. Only
// touches objects that carry `stops`; everything else passes through unchanged.
router.use((_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(signTripResponse(body));
  next();
});

const tripInclude = TRIP_INCLUDE;

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
const TICKET_CREATE_RETRIES = 5;

/** "YYYYMMDD" of the MYT day — matches the MYT day-window the count uses. */
export function ticketDatePart(now: Date): string {
  return mytDateKey(now).replace(/-/g, "");
}

/**
 * Sequence number for an attempt. Attempt 0 is the clean sequential number
 * (countToday + 1). Retries add a random spread ON TOP of the +attempt bump:
 * simultaneous losers re-count the same countToday and would otherwise compute
 * identical sequences on every retry round (lockstep collisions — how a burst
 * of >~4 same-instant bookings used to exhaust the budget). The spread widens
 * with each attempt, so contenders disperse fast; the cost is a small gap in
 * that day's numbering, only ever under simultaneous-booking contention.
 * Pure; `rand` injectable for deterministic tests. Exported for unit tests.
 */
export function ticketSequence(countToday: number, attempt: number, rand: () => number = Math.random): number {
  const spread = attempt === 0 ? 0 : Math.floor(rand() * 8 * attempt);
  return countToday + 1 + attempt + spread;
}

async function generateTicketNumber(now: Date, attempt = 0): Promise<string> {
  const dayStart = getTripDayStart(now);
  const dayEnd = getTripDayEnd(now);
  const countToday = await prisma.trip.count({
    where: { created_at: { gte: dayStart, lt: dayEnd } },
  });
  const sequence = String(ticketSequence(countToday, attempt)).padStart(3, "0");
  return `TKT-${ticketDatePart(now)}-${sequence}`;
}

// ── POST /trips — requestor submits a booking ───────────────────────────
// Small grace window so a "now" pickup isn't rejected by clock skew between
// the requestor's device and the server.
export const PICKUP_GRACE_MS = 15 * 60 * 1000;

// Booking targets must exist AND be active: a consignee an admin deactivated
// (e.g. a wrong-zone duplicate) stays reachable through stale references —
// recent-consignee chips and "Rebook last trip" hold old IDs — so search-level
// filtering alone can't stop it being re-booked. Exported for unit tests.
/**
 * 400 whose message names the failing stop POSITION(S) (DG-R9): both booking
 * paths threw a generic "one or more consignees…" string, leaving a requestor
 * with N stops to guess which one broke — while the failing ids were computable
 * at both sites. Same code, richer message; clients surface it verbatim.
 */
export function consigneesNotFoundError(
  stops: { consignee_id: string }[],
  found: { id: string }[]
): ApiError {
  const ok = new Set(found.map((c) => c.id));
  const positions = stops
    .map((s, i) => (ok.has(s.consignee_id) ? null : i + 1))
    .filter((n): n is number => n !== null);
  const label =
    positions.length === 1 ? `stop ${positions[0]}` : `stops ${positions.join(", ")}`;
  return new ApiError(
    400,
    "CONSIGNEE_NOT_FOUND",
    `The consignee for ${label} is no longer available (it may have been removed or deactivated) — please reselect it.`
  );
}

export const bookableConsigneesWhere = (ids: string[]) => ({
  id: { in: ids },
  is_active: true,
});

// Exported for unit tests (tests/tripValidation.test.ts).
/**
 * One cargo line, parameterised by the accepted pallet_type VOCABULARY. Normalise
 * the SPELLING first (ASCII "5x10"/"5 x 10" → "5×10", the workbook's own
 * notation), THEN enum — so the spec's spelling round-trips and stores canonical.
 *
 * NEW bookings pass BOOKABLE_CARGO_TYPES (Q1, R1 2026-07-24: 1×1/1×2 removed —
 * they are boxes, not pallets). EDITS of historical bookings pass the full
 * CARGO_PALLET_TYPES so an existing 1×1/1×2 line still PARSES; a separate runtime
 * guard (deprecatedCargoViolations) then blocks introducing or increasing a
 * deprecated size on an edit. Either way the factor/capacity math is unchanged.
 */
export function cargoLineSchema(
  types: readonly [string, ...string[]],
  opts: { allowLegacyCustom?: boolean } = {}
) {
  const allowLegacyCustom = opts.allowLegacyCustom ?? false;
  return z
    .object({
      pallet_type: z.preprocess(
        (v) => (typeof v === "string" ? normalizePalletType(v) : v),
        z.enum(types)
      ),
      quantity: z.number().int().min(1),
      cartons: z.number().int().min(0).optional(),
      custom_size: z.string().optional(),
      // Q10 structured dimensions (feet) for crate/rack/custom. Positive + finite
      // rejects 0, negative, NaN and ±Infinity at the schema level.
      width_ft: z.number().finite().positive().optional(),
      length_ft: z.number().finite().positive().optional(),
      // Optional requestor estimate of 4×4-pallet space for a carton line (its
      // estimate may size auto-dispatch). box/crate/rack/custom ALWAYS route to
      // manual assignment, so an estimate never lets them auto-dispatch.
      estimated_pallets: z.number().int().min(1).optional(),
      remark: z.string().optional(),
    })
    .superRefine((line, ctx) => {
      const type = line.pallet_type;
      const hasDims = line.width_ft != null && line.length_ft != null;
      // Both dimensions must be present together.
      if ((line.width_ft != null) !== (line.length_ft != null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["length_ft"], message: "Both width_ft and length_ft are required." });
      }
      if (type === "crate" || type === "rack") {
        if (!hasDims) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["width_ft"], message: "Crate and Rack require width_ft and length_ft in feet." });
      } else if (type === "custom") {
        // NEW custom requires structured dims; EDIT may keep a legacy free-text size.
        const hasLegacy = allowLegacyCustom && typeof line.custom_size === "string" && line.custom_size.trim().length > 0;
        if (!hasDims && !hasLegacy) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["width_ft"], message: "Custom cargo requires width_ft and length_ft in feet." });
      } else if (type === "box") {
        if (line.width_ft != null || line.length_ft != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["width_ft"], message: "Box has no dimensions — use a count only." });
      }
    });
}

export const createTripSchema = z.object({
  // DG-T7 idempotency key. Optional so an older client keeps working unchanged
  // (an unkeyed booking is simply not deduplicated). Bounded and non-empty so a
  // junk value can't bloat the unique index; any opaque string is accepted
  // rather than strict UUID, since it is only ever compared for equality.
  client_request_id: z.string().min(8).max(128).optional(),
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
  cargo_details: z.array(cargoLineSchema(BOOKABLE_CARGO_TYPES)).min(1, "At least one cargo line is required."),
});

router.post(
  "/",
  requireRole("requestor", "admin"),
  validateBody(createTripSchema),
  async (req, res, next) => {
    try {
      const { client_request_id, route_type_id, pickup_datetime, is_external, stops, cargo_details } =
        req.body;

      // ── DG-T7 idempotency, fast path ──────────────────────────────────────
      // The form reuses one key for every retry of the SAME booking, so a
      // submit that timed out but actually committed lands here and returns the
      // ORIGINAL trip. Without this the retry created a second booking and, in
      // `auto` mode, immediately dispatched a second truck.
      //
      // Scoped by requestor: the key alone must never be able to surface
      // somebody else's booking. This is only the fast path — the unique index
      // below is what actually closes the concurrent race.
      if (client_request_id) {
        const existing = await prisma.trip.findFirst({
          where: { requestor_id: req.user!.id, client_request_id },
          include: tripInclude,
        });
        if (existing) {
          res.status(201).json(existing);
          return;
        }
      }

      const routeType = await prisma.routeType.findUnique({ where: { id: route_type_id } });
      if (!routeType) {
        throw new ApiError(400, "ROUTE_TYPE_NOT_FOUND", "Route type does not exist.");
      }

      const consigneeIds = stops.map((s: { consignee_id: string }) => s.consignee_id);
      const foundConsignees = await prisma.consignee.findMany({
        where: bookableConsigneesWhere(consigneeIds),
      });
      if (foundConsignees.length !== new Set(consigneeIds).size) {
        throw consigneesNotFoundError(stops, foundConsignees);
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
              client_request_id,
              requestor_id: req.user!.id,
              route_type_id,
              pickup_datetime,
              is_external: is_external ?? false,
              stops: {
                // Normalised to a contiguous, tie-free 1..N — the truck pick and
                // the POD asset id both read stop order. See lib/stopSequence.
                create: normalizeStopSequences(stops as { consignee_id: string; sequence?: number }[]).map((s) => ({
                  consignee_id: s.consignee_id,
                  sequence: s.sequence,
                })),
              },
              cargo_details: { create: cargo_details.map(withCanonicalCargoSize) },
            },
            include: tripInclude,
          });
          break;
        } catch (err) {
          // ── DG-T7 idempotency, race path ────────────────────────────────
          // Two retries in flight at once: the fast path above found nothing
          // for either, and the loser now trips the unique index. Return the
          // WINNER's trip — the caller cannot tell which request created it,
          // which is exactly the point.
          //
          // Checked BEFORE the ticket branch, and with the STRICT matcher: the
          // permissive isUniqueViolation answers `true` when Prisma reports no
          // target metadata, which would send ticket collisions down this path
          // and turn a retryable one into a spurious conflict. Named-column
          // match only — an unnamed violation falls through to the ticket
          // retry, preserving the existing behaviour exactly.
          if (client_request_id && isUniqueViolationOnField(err, "client_request_id")) {
            const winner = await prisma.trip.findFirst({
              where: { requestor_id: req.user!.id, client_request_id },
              include: tripInclude,
            });
            if (winner) {
              res.status(201).json(winner);
              return;
            }
            // The constraint fired but the row isn't readable (it lost its own
            // transaction, or a rollback beat this read). Fall through: this is
            // a genuine conflict, not a settled duplicate.
            throw new ApiError(
              409,
              "BOOKING_IN_FLIGHT",
              "This booking is still being submitted — please check your bookings before trying again."
            );
          }
          if (!isUniqueViolation(err, "ticket_number")) {
            throw err;
          }
          if (attempt < TICKET_CREATE_RETRIES) {
            continue;
          }
          // Budget exhausted under extreme same-instant booking load. The
          // unique constraint held (no duplicate exists — that's exactly what
          // fired); surface a clean retryable conflict instead of the raw
          // P2002 500 this used to produce. Submitting again succeeds.
          throw new ApiError(
            409,
            "TICKET_CONFLICT",
            "The system is busy taking bookings right now — please submit again."
          );
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

// ── PATCH /trips/:id — requestor fixes their own still-PENDING booking ────
// Full replace of the requestor-typo surface (route type, pickup, stops,
// cargo/notes) with the same validation as create. Everything else is locked:
// is_external (the assign-external flow is the admin's lever), documents
// (their own endpoints), and every status/assignment/money field. Pending
// only — once a driver is claimed the booking is immutable to the requestor.
//
// pickup_datetime deliberately drops create's not-in-the-past refine: a
// requestor fixing a consignee 20 minutes after a "now" booking must not be
// rejected over the pickup they aren't touching. The handler enforces the
// grace window only when the pickup actually CHANGED.
export const updateTripSchema = z.object({
  route_type_id: z.string().min(1),
  pickup_datetime: z.coerce.date(),
  stops: createTripSchema.shape.stops,
  // Full/legacy vocabulary so a historical 1×1/1×2 line still PARSES on edit (the
  // create schema's BOOKABLE enum would 400 the whole update). Optional: when the
  // client omits cargo_details entirely, the handler preserves existing cargo
  // unchanged. Introducing/increasing a deprecated size is blocked at runtime by
  // deprecatedCargoViolations, not by the parser.
  cargo_details: z
    // allowLegacyCustom: a historical `custom` line carrying only a free-text
    // custom_size (no structured dims) must still PARSE on edit and be preserved.
    .array(cargoLineSchema(CARGO_PALLET_TYPES, { allowLegacyCustom: true }))
    .min(1, "At least one cargo line is required.")
    .optional(),
});

type UpdateTripInput = z.infer<typeof updateTripSchema>;

/**
 * A trip-edit's cargo, in the plain shape summarizeTripChanges compares (cargo is
 * always resolved to a concrete array by the handler — either the submitted lines
 * or, when omitted, the existing ones).
 */
export interface TripEditInput {
  route_type_id: string;
  pickup_datetime: Date;
  stops: { sequence?: number | null; consignee_id: string }[];
  cargo_details: {
    pallet_type: string;
    quantity: number;
    cartons?: number | null;
    custom_size?: string | null;
    width_ft?: number | null;
    length_ft?: number | null;
    estimated_pallets?: number | null;
    remark?: string | null;
  }[];
}

/**
 * Deprecated-size edit guard (Q1 legacy-edit fix). A deprecated footprint (1×1 /
 * 1×2) may only be PRESERVED, REDUCED or REMOVED on an edit — never introduced or
 * increased. Compares NORMALISED aggregate quantities (so "1x1"/"1×1" collapse,
 * and multiple lines of the same size sum) between the stored booking and the
 * submitted cargo, and returns every deprecated size whose total went UP (a new
 * type is existing 0 → next > 0; an increase is next > existing). Empty = allowed.
 * Pure — unit-tested; the handler throws a 400 when it returns anything.
 */
export function deprecatedCargoViolations(
  existing: { pallet_type: string; quantity: number }[],
  next: { pallet_type: string; quantity: number }[]
): { pallet_type: string; existing: number; next: number }[] {
  const deprecated = new Set<string>(DEPRECATED_PALLET_SIZES as readonly string[]);
  const aggregate = (lines: { pallet_type: string; quantity: number }[]) => {
    const totals = new Map<string, number>();
    for (const l of lines) {
      const key = normalizePalletType(l.pallet_type);
      if (!deprecated.has(key)) continue;
      totals.set(key, (totals.get(key) ?? 0) + l.quantity);
    }
    return totals;
  };
  const existingTotals = aggregate(existing);
  const nextTotals = aggregate(next);
  const violations: { pallet_type: string; existing: number; next: number }[] = [];
  for (const [size, nextQty] of nextTotals) {
    const existingQty = existingTotals.get(size) ?? 0;
    if (nextQty > existingQty) violations.push({ pallet_type: size, existing: existingQty, next: nextQty });
  }
  return violations;
}

// Existing-trip slice summarizeTripChanges compares against (plain shape so the
// helper stays pure and unit-testable without a DB).
export interface TripEditSnapshot {
  route_type_id: string;
  pickup_datetime: Date;
  stops: { sequence: number; consignee_id: string }[];
  cargo_details: {
    pallet_type: string;
    quantity: number;
    cartons: number | null;
    custom_size: string | null;
    width_ft: number | null;
    length_ft: number | null;
    estimated_pallets: number | null;
    remark: string | null;
  }[];
}

/**
 * Human summary of what an edit changed — the `note` on the `edited` history
 * event ("who changed what"): e.g. "pickup time; consignees; cargo". Returns
 * null when nothing differs (the route then skips the write entirely — a no-op
 * submit must not pollute the audit trail or re-trigger dispatch). Notes
 * (cargo-line remarks) are called out separately from real cargo changes
 * because that's how the requestor thinks of them. Exported for unit tests.
 */
export function summarizeTripChanges(existing: TripEditSnapshot, next: TripEditInput): string | null {
  const changed: string[] = [];

  if (existing.route_type_id !== next.route_type_id) changed.push("route type");
  if (existing.pickup_datetime.getTime() !== next.pickup_datetime.getTime()) changed.push("pickup time");

  const orderedConsignees = (stops: { sequence?: number | null; consignee_id: string }[]) =>
    stops
      .map((s, idx) => ({ seq: s.sequence ?? idx + 1, id: s.consignee_id }))
      .sort((a, b) => a.seq - b.seq)
      .map((s) => s.id)
      .join("|");
  if (orderedConsignees(existing.stops) !== orderedConsignees(next.stops)) changed.push("consignees");

  // Cargo compared line-by-line in order; remark-only differences report as
  // "notes", anything else as "cargo".
  const cargoLine = (c: TripEditInput["cargo_details"][number] | TripEditSnapshot["cargo_details"][number]) =>
    [c.pallet_type, c.quantity, c.cartons ?? "", c.custom_size ?? "", c.width_ft ?? "", c.length_ft ?? "", c.estimated_pallets ?? ""].join("|");
  const remarkLine = (c: { remark?: string | null }) => c.remark ?? "";
  const sameCargo =
    existing.cargo_details.length === next.cargo_details.length &&
    existing.cargo_details.every((c, i) => cargoLine(c) === cargoLine(next.cargo_details[i]));
  const sameRemarks =
    existing.cargo_details.length === next.cargo_details.length &&
    existing.cargo_details.every((c, i) => remarkLine(c) === remarkLine(next.cargo_details[i]));
  if (!sameCargo) changed.push("cargo");
  if (sameCargo && !sameRemarks) changed.push("notes");

  return changed.length > 0 ? changed.join("; ") : null;
}

/**
 * Validate a proposed trip edit against the live booking. Pure of side effects:
 * it reads reference data and throws, but writes nothing.
 *
 * ONE definition, TWO callers, and that is the whole point:
 *   - PATCH /trips/:id — the requestor editing a still-PENDING booking;
 *   - the change-request APPROVAL — an admin applying a proposal to an ASSIGNED
 *     booking (Mr. Teh's A19 flow).
 *
 * A stored change-request payload is re-validated through this at APPROVAL time,
 * not at submission time, so a proposal written before a rule changed can never
 * bypass the new rule. If these two paths ever validated separately they would
 * drift, and the drift would show up as an admin approving something a requestor
 * could not have typed.
 *
 * Returns the resolved cargo (submitted lines, or the existing ones when the
 * client omitted cargo entirely) and the human change summary — `null` summary
 * means nothing actually changed, which each caller handles its own way.
 */
async function validateTripEdit(
  existing: Prisma.TripGetPayload<{ include: { stops: true; cargo_details: true } }>,
  input: UpdateTripInput
): Promise<{ effectiveCargo: TripEditInput["cargo_details"]; changeNote: string | null }> {
  const { route_type_id, pickup_datetime, stops, cargo_details } = input;

  // Cargo is OPTIONAL: when omitted, preserve the existing cargo unchanged
  // (resolved from the stored rows). When present, it replaces the cargo — but
  // only after the deprecated-size guard below.
  const cargoProvided = cargo_details !== undefined;
  const existingCargoInput = existing.cargo_details.map((c) => ({
    pallet_type: c.pallet_type,
    quantity: c.quantity,
    cartons: c.cartons ?? undefined,
    custom_size: c.custom_size ?? undefined,
    width_ft: c.width_ft ?? undefined,
    length_ft: c.length_ft ?? undefined,
    estimated_pallets: c.estimated_pallets ?? undefined,
    remark: c.remark ?? undefined,
  }));
  const effectiveCargo = cargoProvided ? cargo_details! : existingCargoInput;

  // A deprecated footprint (1×1/1×2) may only be preserved/reduced/removed on
  // an edit — never introduced or increased.
  if (cargoProvided) {
    const violations = deprecatedCargoViolations(existing.cargo_details, cargo_details!);
    if (violations.length > 0) {
      const sizes = violations.map((v) => v.pallet_type).join(", ");
      throw new ApiError(
        400,
        "DEPRECATED_CARGO_ADDED",
        `${sizes} is no longer a bookable cargo size and cannot be added or increased. Existing quantities may only be kept or reduced.`
      );
    }
  }

  // Same checks as create, against the NEW values.
  if (pickup_datetime.getTime() !== existing.pickup_datetime.getTime()) {
    if (pickup_datetime.getTime() < Date.now() - PICKUP_GRACE_MS) {
      throw new ApiError(400, "PICKUP_IN_PAST", "Pickup time is in the past.");
    }
  }
  const routeType = await prisma.routeType.findUnique({ where: { id: route_type_id } });
  if (!routeType) {
    throw new ApiError(400, "ROUTE_TYPE_NOT_FOUND", "Route type does not exist.");
  }
  const consigneeIds = stops.map((s) => s.consignee_id);
  const foundConsignees = await prisma.consignee.findMany({
    where: bookableConsigneesWhere(consigneeIds),
  });
  if (foundConsignees.length !== new Set(consigneeIds).size) {
    throw consigneesNotFoundError(stops, foundConsignees);
  }
  if (!existing.is_external) {
    const orderPallets = palletEquivalents(effectiveCargo);
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

  const changeNote = summarizeTripChanges(existing, {
    route_type_id,
    pickup_datetime,
    stops,
    cargo_details: effectiveCargo,
  });
  return { effectiveCargo, changeNote };
}

router.patch(
  "/:id",
  requireRole("requestor"),
  validateBody(updateTripSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { route_type_id, pickup_datetime, stops, cargo_details } = req.body as UpdateTripInput;

      const existing = await prisma.trip.findUnique({
        where: { id },
        include: { stops: true, cargo_details: true },
      });
      if (!existing) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (existing.requestor_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You cannot edit this booking.");
      }
      if (existing.status !== "pending") {
        throw new ApiError(
          400,
          "INVALID_STATUS",
          "Only bookings that have not been assigned yet can be edited."
        );
      }

      const { effectiveCargo, changeNote } = await validateTripEdit(existing, {
        route_type_id,
        pickup_datetime,
        stops,
        cargo_details,
      });
      const cargoProvided = cargo_details !== undefined;
      if (changeNote === null) {
        // Nothing changed — don't write, don't audit, don't poke dispatch.
        const unchanged = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
        res.json(unchanged);
        return;
      }

      await prisma.$transaction(async (tx) => {
        // Status-guarded CAS FIRST (mirrors cancel): writing the Trip row here
        // both re-checks pending and takes the row lock, so an edit racing
        // auto-dispatch/approve resolves cleanly — the edit loses with a 409,
        // or an in-flight serializable dispatch that already read the OLD
        // stops/cargo aborts on this very row write and retries against the
        // new ones. The stale auto_dispatch flags are cleared because they
        // describe cargo/destinations that may no longer exist; if dispatch
        // still can't place the edited booking, the retry below re-sets them
        // with the fresh reason.
        const claimed = await tx.trip.updateMany({
          where: { id, status: "pending" },
          data: {
            route_type_id,
            pickup_datetime,
            auto_dispatch_failed: false,
            auto_dispatch_note: null,
          },
        });
        if (claimed.count !== 1) {
          throw new ApiError(
            409,
            "TRIP_STATE_CHANGED",
            "This booking just changed state (a driver may have just been assigned). Refresh and try again."
          );
        }
        // Pending stops/cargo have no PODs, no history references and no
        // snapshots (those are written at assignment) — replace wholesale.
        await tx.tripStop.deleteMany({ where: { trip_id: id } });
        await tx.tripStop.createMany({
          data: normalizeStopSequences(stops).map((s) => ({
            trip_id: id,
            consignee_id: s.consignee_id,
            sequence: s.sequence,
          })),
        });
        // Only rewrite cargo when the client actually submitted it; an omitted
        // cargo_details preserves the existing rows untouched.
        if (cargoProvided) {
          await tx.cargoDetail.deleteMany({ where: { trip_id: id } });
          await tx.cargoDetail.createMany({
            // Canonicalise structured dims; a legacy free-text custom_size (no
            // dims) is preserved verbatim (withCanonicalCargoSize is a no-op on it).
            data: cargo_details!.map((c) => ({ ...withCanonicalCargoSize(c), trip_id: id })),
          });
        }
        await tx.auditLog.create({
          data: { user_id: req.user!.id, action: "trip.updated", table_name: "Trip", record_id: id },
        });
        await recordTripEvent(tx, {
          tripId: id,
          event: "edited",
          actorId: req.user!.id,
          note: changeNote,
        });
      });

      // The edit may change what dispatch would pick (capacity, zone), and the
      // minute-sweep never retries a booking that already alerted admins
      // (pending_alert_sent) — so re-evaluate NOW in auto mode, exactly like
      // create. Best-effort: a dispatch failure must never break the edit.
      let result = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      try {
        if ((await getDispatchMode()) === "auto") {
          const dispatch = await autoDispatchTrip(id);
          if (dispatch.assigned && dispatch.trip) {
            result = dispatch.trip;
          }
        }
      } catch (err) {
        console.error("Auto-dispatch on edit failed:", err);
      }

      res.json(result);
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
  "pending_approval",
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
    // List mode (lib/tripCursor):
    //  - legacy: plain array, optional newest-N `limit` window (cb6bd55) —
    //    mobile's role-scoped lists and the admin Dashboard/MobileLite/
    //    Reports windows, unchanged.
    //  - paged (`page_size`/`cursor` present): {items, next_cursor, total}
    //    keyset pages under (created_at DESC, id DESC) — the admin board
    //    polls the first page as its live head and loads older pages on
    //    demand instead of re-downloading a capped window every 20s.
    // Filters below always search the FULL table in both modes; the window/
    // page only caps how many matching rows come back per request.
    const listQuery = parseTripListQuery(req.query);
    if (listQuery.mode === "invalid_cursor") {
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "The pagination cursor is not valid. Reload the list and try again."
      );
    }

    const filters: Prisma.TripWhereInput[] = [];

    if (status && (TRIP_STATUSES as readonly string[]).includes(status)) {
      filters.push({ status: status as Prisma.TripWhereInput["status"] });
    }
    if (driverId) filters.push({ driver_id: driverId });
    // Zone matches any stop whose consignee sits in that zone.
    if (zone) filters.push({ stops: { some: { consignee: { zone_code: zone } } } });

    // Pickup-date range (inclusive), cut on MYT calendar days — the same
    // wall clock the cards display (28d0e88). The old parse used
    // new Date("YYYY-MM-DD") = UTC midnight = 08:00 MYT, so "From 5 Jul"
    // silently excluded trips picked up 00:00–07:59 MYT that day, and the
    // end-of-day stretch depended on the server's TZ env. Malformed keys are
    // ignored rather than erroring (unchanged behaviour).
    const range: Prisma.DateTimeFilter = {};
    const fromDay = dateFrom ? mytDayBoundsForKey(dateFrom) : null;
    const toDay = dateTo ? mytDayBoundsForKey(dateTo) : null;
    if (fromDay) range.gte = fromDay.start;
    if (toDay) range.lt = toDay.end; // [start, end) — covers the whole MYT "to" day
    if (range.gte || range.lt) filters.push({ pickup_datetime: range });

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

    if (listQuery.mode === "paged") {
      // Keyset page: the cursor predicate ANDs onto the role scope + filters,
      // so a cursor taken from a filtered page continues that same filtered
      // sequence. `total` counts the filtered set (cursor excluded) — the
      // board shows "N of total" and sizes its Load-older button from it.
      const pageWhere: Prisma.TripWhereInput = listQuery.cursor
        ? { AND: [where, tripKeysetWhere(listQuery.cursor)] }
        : where;
      const [rows, total] = await Promise.all([
        prisma.trip.findMany({
          where: pageWhere,
          include: tripInclude,
          orderBy: [...TRIP_LIST_ORDER],
          take: listQuery.pageSize + 1, // +1 = "does a next page exist"
        }),
        prisma.trip.count({ where }),
      ]);
      res.json({ ...buildTripPage(rows, listQuery.pageSize), total });
      return;
    }

    const trips = await prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: [...TRIP_LIST_ORDER],
      ...(listQuery.limit !== undefined ? { take: listQuery.limit } : {}),
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

// ── GET /trips/:id/route — real road polyline, from PRE-COMPUTED legs ─────────
//
// No routing provider is called at request time: the geometry was generated
// offline by a local OpenRouteService and ships as data (services/routeLegs.ts).
// Routes UWC plant → each stop's zone centroid in sequence, falling back to a
// straight line if a leg is missing or stale, so the map always renders.
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

    // The stops' ZONE CODES in order — the service keys the pre-computed legs
    // off these and collapses consecutive duplicates itself (several stops in
    // one zone are one destination).
    const route = await getRoute(trip.stops.map((s) => s.consignee.zone_code));

    res.json(route);
  } catch (err) {
    next(err);
  }
});

// ── GET /trips/:id/tracking-link — shareable public tracking URL (owner/admin) ──
// The owner requestor (or an admin) gets a signed <host>/track/<token> link they
// can forward to their own customer. Read-only, non-sensitive status only.
router.get("/:id/tracking-link", async (req, res, next) => {
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: req.params.id },
      select: { id: true, requestor_id: true },
    });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
    if (!isOwner && req.user!.role !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to view this trip.");
    }
    const token = signTrackingToken(trip.id);
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.json({ url: `${base}/track/${token}` });
  } catch (err) {
    next(err);
  }
});

// ── GET /trips/:id/location — best GPS fix for this trip (owner/driver/admin) ──
//
// Lets the requestor track their own delivery without exposing the whole fleet
// (GET /fleet/live is admin-only). Same source-preference resolver as the fleet
// map; returns null (→ approximate) when there are no fixes.
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

    const logs = await prisma.locationLog.findMany({
      where: { trip_id: req.params.id },
      orderBy: { recorded_at: "desc" },
      take: 20,
      select: { latitude: true, longitude: true, recorded_at: true, source: true },
    });
    const fix = resolveFleetFix(logs);
    if (!fix) {
      res.json(null);
      return;
    }

    res.json({
      latitude: fix.latitude,
      longitude: fix.longitude,
      recorded_at: fix.recorded_at,
      source: fix.source,
      stale: fix.stale,
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
              select: { pallet_type: true, quantity: true, estimated_pallets: true },
            });
            // Capacity is scoped to THIS trip's pickup MYT day (16 Jul 2026 trial
            // fix): in_progress cargo is physically aboard and always counts, but
            // an assignment only occupies the truck on its own pickup day — a
            // 17-Jul booking must not make a 16-Jul assign TRUCK_OVERLOADED.
            const pickupDay = mytDayBoundsForKey(mytDateKey(trip.pickup_datetime))!;
            const truck = await tx.truck.findUnique({
              where: { plate: truck_plate },
              include: {
                trips: {
                  where: {
                    id: { not: id },
                    OR: [
                      { status: "in_progress" },
                      {
                        status: "assigned",
                        pickup_datetime: { gte: pickupDay.start, lt: pickupDay.end },
                      },
                    ],
                  },
                  select: { cargo_details: { select: { pallet_type: true, quantity: true, estimated_pallets: true } } },
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
              auto_dispatch_note: null,
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
        // Pin the trip to MANUAL handling (feedback item 15, 16 Jul 2026: "no
        // more auto after unassign"). Back in pending, the sweep would otherwise
        // auto-re-dispatch it — often straight back to a truck the admin just
        // pulled it off. This flag makes the sweep skip it; the admin now rejects
        // or manually re-assigns. Cleared automatically on the next assign claim.
        await tx.trip.update({ where: { id }, data: { auto_dispatch_paused: true } });
        // Drop the per-stop zone-point snapshots too — they belong to the old
        // assignment; the next assignment re-takes them.
        // Clear BOTH stop snapshots (points + zone identity): back in pending,
        // the trip must re-snapshot whatever is true at its NEXT assignment.
        await tx.tripStop.updateMany({ where: { trip_id: id }, data: { zone_points: null, zone_code: null } });
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
      // Status-guarded CAS (mirrors approve/unassign): the reject applies only
      // while the trip is still pending — a collision with the auto-dispatch
      // sweep (which just claimed it) or another admin loses cleanly instead
      // of stamping "rejected" over an assigned trip.
      await prisma.$transaction(async (tx) => {
        const rejected = await rejectPendingTrip(tx, id, reason ?? null);
        if (!rejected) {
          throw new ApiError(
            409,
            "TRIP_STATE_CHANGED",
            "This booking just changed state (it may have been assigned or cancelled). Refresh and try again."
          );
        }
        await tx.auditLog.create({
          data: { user_id: req.user!.id, action: "trip.rejected", table_name: "Trip", record_id: id },
        });
        await recordTripEvent(tx, {
          tripId: id,
          event: "rejected",
          actorId: req.user!.id,
          note: reason ?? null,
        });
      });
      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });

      const requestorDevice = await prisma.user.findUnique({
        where: { id: trip.requestor_id },
        select: { expo_push_token: true },
      });
      const reasonSuffix = reason ? `: ${reason}` : "";
      await sendPushNotifications([requestorDevice?.expo_push_token], {
        title: "Booking rejected",
        body: `Your booking ${trip.ticket_number} was rejected${reasonSuffix}`,
        data: { type: "booking_rejected", tripId: id },
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

      // Status-guarded CAS FIRST, forwarder details second, one transaction
      // (mirrors approve/unassign): a collision with the auto-dispatch sweep
      // used to stamp assigned+is_external over a trip that had just been
      // given an internal driver + rate snapshot — an "outsourced" trip a
      // driver was still rolling on. Now the losing side gets a 409 and no
      // forwarder row is left behind.
      await prisma.$transaction(async (tx) => {
        const outsourced = await outsourcePendingTrip(tx, id);
        if (!outsourced) {
          throw new ApiError(
            409,
            "TRIP_STATE_CHANGED",
            "This booking just changed state (auto-dispatch or another admin may have assigned it). Refresh and try again."
          );
        }
        await tx.externalForwarder.upsert({
          where: { trip_id: id },
          create: { trip_id: id, company_name, booking_date, rate, cargo_size },
          update: { company_name, booking_date, rate, cargo_size },
        });
        await tx.auditLog.create({
          data: {
            user_id: req.user!.id,
            action: "trip.assigned_external",
            table_name: "Trip",
            record_id: id,
          },
        });
        await recordTripEvent(tx, {
          tripId: id,
          event: "assigned_external",
          actorId: req.user!.id,
          note: company_name,
        });
      });
      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
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
      // ⚠ NAMES THE REMEDY, because in practice this is the requestor's ONLY
      // encounter with it. Prod dispatches automatically, so a booking is
      // assigned before the create response returns and the self-cancel window
      // is effectively zero — this message is what they actually see. Stating
      // the rule alone left them with no next step and no one to ask.
      throw new ApiError(
        400,
        "INVALID_STATUS",
        "A driver has already been assigned, so this booking can no longer be cancelled here. Call the office to cancel it."
      );
    }

    // Status-guarded CAS (mirrors approve/unassign): cancel applies only while
    // the trip is still pending/approved — if auto-dispatch or an admin just
    // assigned it, the cancel loses with a 409 instead of producing a
    // cancelled trip that still has a driver and truck attached.
    await prisma.$transaction(async (tx) => {
      const cancelled = await cancelBookedTrip(tx, id);
      if (!cancelled) {
        throw new ApiError(
          409,
          "TRIP_STATE_CHANGED",
          "This booking just changed state (a driver may have just been assigned). Refresh and try again."
        );
      }
      await tx.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.cancelled", table_name: "Trip", record_id: id },
      });
      await recordTripEvent(tx, { tripId: id, event: "cancelled", actorId: req.user!.id });
    });
    const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });

    // An admin cancelling someone else's booking mirrors reject: tell the
    // requestor, who would otherwise assume the delivery is still coming.
    // Self-cancels are not echoed back. Best-effort, never blocks. NOTE: Expo
    // pushes only reach native installs — web users still see the change on
    // the next in-app refresh.
    if (isAdmin && trip.requestor_id !== req.user!.id) {
      const requestorDevice = await prisma.user.findUnique({
        where: { id: trip.requestor_id },
        select: { expo_push_token: true },
      });
      await sendPushNotifications([requestorDevice?.expo_push_token], {
        title: "Booking cancelled",
        body: `Your booking ${trip.ticket_number} was cancelled by the dispatcher`,
        data: { type: "booking_cancelled", tripId: id },
      });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * A human, VALUE-BEARING description of what a change request would do.
 *
 * summarizeTripChanges returns field NAMES ("consignees; cargo") — right for a
 * timeline entry beside the booking, useless as an approval gate. The admin
 * approving this is making a pay decision: Ipoh (6 pts) to Juru & Perai (1 pt)
 * takes a weekday drop from (6-2)x11 = RM44 to max(1-2,0)x11 = RM0, and both
 * render as the single word "consignees". Show before -> after.
 */
async function describeTripChange(
  existing: Prisma.TripGetPayload<{ include: { stops: true; cargo_details: true } }>,
  input: UpdateTripInput
): Promise<string[]> {
  const lines: string[] = [];

  if (existing.pickup_datetime.getTime() !== input.pickup_datetime.getTime()) {
    lines.push(`Pickup: ${existing.pickup_datetime.toISOString()} -> ${input.pickup_datetime.toISOString()}`);
  }

  const beforeIds = [...existing.stops].sort((a, b) => a.sequence - b.sequence).map((s) => s.consignee_id);
  const afterIds = input.stops.map((s) => s.consignee_id);
  if (beforeIds.join("|") !== afterIds.join("|")) {
    const names = new Map(
      (await prisma.consignee.findMany({
        where: { id: { in: [...new Set([...beforeIds, ...afterIds])] } },
        select: { id: true, company_name: true, zone_code: true },
      })).map((c) => [c.id, `${c.company_name} (${c.zone_code})`])
    );
    lines.push(`Stops: ${beforeIds.map((i) => names.get(i) ?? "?").join(" -> ")}  ==>  ${afterIds.map((i) => names.get(i) ?? "?").join(" -> ")}`);
  }

  if (input.cargo_details !== undefined) {
    const line = (c: { pallet_type: string; quantity: number }) => `${c.quantity}x ${c.pallet_type}`;
    const before = existing.cargo_details.map(line).join(", ");
    const after = input.cargo_details.map(line).join(", ");
    if (before !== after) {
      lines.push(`Cargo: ${before}  ==>  ${after} (${palletEquivalents(existing.cargo_details)} -> ${palletEquivalents(input.cargo_details)} pallet-equivalents)`);
    }
  }

  return lines;
}

/**
 * A fingerprint of the trip's EDITABLE state — the exact fields a change
 * request proposes to replace.
 *
 * A stored proposal is a full-document overwrite, so it must not be applied to a
 * booking that moved underneath it. Reachable path without this: requestor
 * submits a change → admin unassigns → requestor edits the cargo directly (the
 * trip is `pending` again) → trip re-assigned → admin approves the stale
 * proposal, silently REVERTING the requestor's own later edit to the cargo
 * captured at submission, with nothing on screen saying the proposal predates
 * the booking.
 *
 * Deliberately NOT a timestamp: `Trip` has no updated_at, and a hash of the
 * fields actually being replaced is both cheaper and more precise — a change to
 * something a request does not touch (driver, truck) correctly does not
 * invalidate it.
 */
function editableTripFingerprint(trip: {
  route_type_id: string;
  pickup_datetime: Date;
  stops: { sequence: number; consignee_id: string }[];
  cargo_details: { pallet_type: string; quantity: number; cartons: number | null; custom_size: string | null; width_ft: number | null; length_ft: number | null; estimated_pallets: number | null; remark: string | null }[];
}): string {
  const stops = [...trip.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => s.consignee_id)
    .join("|");
  const cargo = trip.cargo_details
    .map((c) => [c.pallet_type, c.quantity, c.cartons ?? "", c.custom_size ?? "", c.width_ft ?? "", c.length_ft ?? "", c.estimated_pallets ?? "", c.remark ?? ""].join(","))
    .join(";");
  return sha256Hex(Buffer.from([trip.route_type_id, trip.pickup_datetime.toISOString(), stops, cargo].join("~")));
}

/**
 * Feature gate for the four Request Change routes. 404 rather than 403: while
 * the feature is off it should be invisible, not merely forbidden — the same
 * discipline the exception router uses.
 */
function assertChangeRequestsEnabled(): void {
  if (!changeRequestsEnabled()) throw new ApiError(404, "NOT_FOUND", "Not found.");
}

// ── Request Change (Mr. Teh A19, 29 Jul 2026 — DOCUMENT tier) ───────────────
//
// > "once a lorry is assigned, the requestor should not be able to directly
// >  change information that affects auto-dispatch... Instead, the requestor
// >  can click 'Request Change', and the system sends the change to the
// >  dispatcher/admin for approval."
//
// A change request is a PROPOSAL, never a partial write: nothing on the trip
// moves until an admin approves, and approval replays the stored payload
// through validateTripEdit — the SAME validation a requestor's own edit uses.
//
// ── HIS LIST, AND WHAT THE EDIT ROUTE ACTUALLY ACCEPTS ─────────────────────
//
// This comment used to claim "every field the edit route accepts is on his
// critical list". That is FALSE by five fields, and it is the kind of claim
// that justifies a wrong decision later — so here is the real mapping.
//
// He named SIX things. They resolve to FOUR fields:
//
//   delivery location   stops[].consignee_id
//   delivery date/time  pickup_datetime
//   pallet quantity     cargo_details[].quantity
//   pallet size         cargo_details[].pallet_type (+ width_ft/length_ft)
//   customer            stops[].consignee_id  — THE SAME FIELD as location
//   priority            ⚠ NO SUCH FIELD HAS EVER EXISTED. Do not build one and
//                         do not ask him about it; the word appears once, here.
//
// updateTripSchema also accepts FIVE fields he never named, and they are not
// equally harmless:
//
//   stops[].sequence            ⚠ DISPATCH-AFFECTING, by his own criterion.
//                               Stop order decides which stop is FIRST, and
//                               dispatchEngine.primaryZone reads the first
//                               stop's zone to lock an A1/A2 run to PND 1888 —
//                               which sets the RM-per-point rate. He would not
//                               recognise the name "sequence", but reordering
//                               stops is exactly "information that affects
//                               auto-dispatch". See lib/stopSequence.
//   cargo_details[].estimated_pallets  ⚠ DISPATCH-AFFECTING. It is the
//                               footprint unsized cargo is dispatched on;
//                               without it the order routes to manual.
//   cargo_details[].remark      display only
//   cargo_details[].cartons     display only
//   route_type_id               a label (id + name). Verified: never read by
//                               dispatchEngine, incentiveEngine or tripFinalize.
//                               ⚠ interplant work may change that.
//
// ── WHY EVERYTHING STILL GOES THROUGH APPROVAL ─────────────────────────────
//
// His matrix says ASSIGNED / requestor = "Can edit non-critical details /
// request change" — two options. Only the second is built: PATCH /trips/:id
// 409s on anything but `pending`, so once assigned this route is the only way
// to change anything. That is STRICTER than he asked, in the safe direction,
// and it was recorded as a deliberate deviation on PR #47.
//
// Owner ruling, 31 Jul 2026: leave it. The genuinely harmless set is only
// remark and cartons (and arguably route_type) — sequence and
// estimated_pallets are dispatch-affecting despite not being on his list — so a
// direct-edit path would buy the requestor very little and is not worth
// building until he says the approval load is a problem.

/** The trip shape both change-request handlers need. */
const changeRequestTripInclude = { stops: true, cargo_details: true } as const;

/** Serialised for the admin queue + the requestor's own view. */
function serializeChangeRequest(cr: {
  id: string;
  trip_id: string;
  requested_by: string;
  requested_at: Date;
  payload: unknown;
  summary: string;
  status: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  version: number;
}) {
  return {
    id: cr.id,
    trip_id: cr.trip_id,
    requested_by: cr.requested_by,
    requested_at: cr.requested_at,
    payload: cr.payload,
    summary: cr.summary,
    status: cr.status,
    decided_by: cr.decided_by,
    decided_at: cr.decided_at,
    decision_note: cr.decision_note,
    version: cr.version,
  };
}

// ── POST /trips/:id/change-request — requestor proposes a change ─────────────
router.post(
  "/:id/change-request",
  requireRole("requestor"),
  validateBody(updateTripSchema),
  async (req, res, next) => {
    try {
      assertChangeRequestsEnabled();
      const { id } = req.params;
      const input = req.body as UpdateTripInput;

      const existing = await prisma.trip.findUnique({
        where: { id },
        include: changeRequestTripInclude,
      });
      if (!existing) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      if (existing.requestor_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You cannot change this booking.");
      }
      // ASSIGNED only. A `pending` booking is still the requestor's to edit
      // directly (PATCH /trips/:id) — routing that through an approval queue
      // would be strictly worse for them and is not what he asked for. Anything
      // in transit or finished is not changeable by anyone (his matrix).
      if (existing.status !== "assigned") {
        throw new ApiError(
          409,
          "INVALID_STATUS",
          existing.status === "pending"
            ? "This booking has no lorry yet — edit it directly instead."
            : "This booking can no longer be changed. Contact the office."
        );
      }

      // Re-validated at approval too; this is the fast feedback so a requestor
      // never queues a proposal an admin could not possibly approve.
      const { changeNote } = await validateTripEdit(existing, input);
      if (changeNote === null) {
        throw new ApiError(400, "NO_CHANGES", "Nothing was changed in this request.");
      }

      const created = await prisma.$transaction(async (tx) => {
        await lockTripRow(tx, id);
        // Re-read under the lock: a driver may have started the trip between
        // the check above and here, which would make the proposal meaningless.
        const t2 = await tx.trip.findUnique({ where: { id }, select: { status: true } });
        if (!t2 || t2.status !== "assigned") {
          throw new ApiError(409, "TRIP_STATE_CHANGED", "This booking just changed state. Refresh and try again.");
        }
        // A newer proposal REPLACES an undecided older one — the requestor
        // changed their mind, and two pending rows could otherwise both be
        // approved into conflicting bookings. The DB partial unique index
        // (TripChangeRequest_one_pending_per_trip) is the hard guarantee; this
        // is the explicit, auditable transition.
        await tx.tripChangeRequest.updateMany({
          where: { trip_id: id, status: "pending" },
          data: { status: "superseded", decided_at: new Date() },
        });
        return tx.tripChangeRequest.create({
          data: {
            trip_id: id,
            requested_by: req.user!.id,
            // Stored as the client sent it (post-zod), so approval re-runs the
            // same shape through the same schema.
            // The proposal AND the fingerprint of the booking it was written
            // against, so approval can refuse a stale overwrite.
            payload: {
              input,
              base: editableTripFingerprint(existing),
              // Value-bearing before -> after, rendered in the admin queue. Kept
              // with the proposal so it describes the booking as it was when the
              // requestor wrote it, not as it is at approval time.
              detail: await describeTripChange(existing, input),
            } as unknown as Prisma.InputJsonValue,
            summary: changeNote,
          },
        });
      });

      await tx_notifyAdminsOfChangeRequest(id, changeNote);
      res.status(201).json({ change_request: serializeChangeRequest(created) });
    } catch (err) {
      next(err);
    }
  }
);

/** Admins hear immediately — an assigned lorry is time-critical, same reasoning
 *  as the at-report exception alert. Best-effort; never fails the request. */
async function tx_notifyAdminsOfChangeRequest(tripId: string, summary: string): Promise<void> {
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { ticket_number: true, truck_plate: true },
    });
    const admins = await prisma.user.findMany({
      where: { role: "admin", status: "active", expo_push_token: { not: null } },
      select: { expo_push_token: true },
    });
    await sendPushNotifications(admins.map((a) => a.expo_push_token), {
      title: "Change requested on an assigned booking",
      body: `${trip?.ticket_number ?? ""}${trip?.truck_plate ? ` (${trip.truck_plate})` : ""} — ${summary}`,
      data: { type: "change_request", tripId },
    });
  } catch (err) {
    console.error("Change-request admin alert failed:", err);
  }
}

// ── GET /trips/change-requests/open — the dispatcher's queue ─────────────────
// Two segments with a literal second, like /trips/exceptions/open, so it cannot
// collide with /trips/:id/change-request.
router.get("/change-requests/open", requireRole("admin"), async (_req, res, next) => {
  try {
    assertChangeRequestsEnabled();
    const rows = await prisma.tripChangeRequest.findMany({
      where: { status: "pending" },
      orderBy: { requested_at: "asc" }, // oldest first — longest wait served first
      include: {
        trip: {
          select: {
            id: true,
            ticket_number: true,
            status: true,
            truck_plate: true,
            pickup_datetime: true,
            requestor: { select: { id: true, name: true } },
            driver: { select: { name: true } },
          },
        },
      },
    });
    res.json({
      change_requests: rows.map((r) => ({
        ...serializeChangeRequest(r),
        ticket_number: r.trip.ticket_number,
        trip_status: r.trip.status,
        truck_plate: r.trip.truck_plate,
        pickup_datetime: r.trip.pickup_datetime,
        requestor_name: r.trip.requestor.name,
        driver_name: r.trip.driver?.name ?? null,
        // The value-bearing lines the dispatcher actually decides on.
        detail: ((r.payload as { detail?: unknown } | null)?.detail as string[] | undefined) ?? [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

const changeDecisionSchema = z.object({
  note: z.string().max(2000).optional(),
  expected_version: z.number().int().min(0).optional(),
});

// ── POST /trips/:id/change-request/:crId/reject ──────────────────────────────
router.post(
  "/:id/change-request/:crId/reject",
  requireRole("admin"),
  validateBody(changeDecisionSchema),
  async (req, res, next) => {
    try {
      assertChangeRequestsEnabled();
      const { id, crId } = req.params;
      const { note, expected_version } = req.body as { note?: string; expected_version?: number };
      if (!note || note.trim() === "") {
        throw new ApiError(400, "NOTE_REQUIRED", "A note is required when rejecting a change request.");
      }
      const decided = await prisma.tripChangeRequest.updateMany({
        where: {
          id: crId,
          trip_id: id,
          status: "pending",
          ...(expected_version !== undefined ? { version: expected_version } : {}),
        },
        data: {
          status: "rejected",
          decided_by: req.user!.id,
          decided_at: new Date(),
          decision_note: note.trim(),
          version: { increment: 1 },
        },
      });
      if (decided.count !== 1) {
        throw new ApiError(409, "CHANGE_REQUEST_STATE_CHANGED", "This change request was already decided. Refresh and try again.");
      }
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: `trip.change_request_rejected: ${note.trim()}`, table_name: "TripChangeRequest", record_id: crId },
      });
      const fresh = await prisma.tripChangeRequest.findUniqueOrThrow({ where: { id: crId } });
      res.json({ change_request: serializeChangeRequest(fresh) });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /trips/:id/change-request/:crId/approve ─────────────────────────────
//
// Applies the proposal to an ASSIGNED booking. Three things make this safe:
//
//  1. RE-VALIDATION. The stored payload goes back through updateTripSchema and
//     validateTripEdit, so a proposal written before a rule changed cannot
//     bypass the new rule, and a consignee deactivated since submission is
//     caught here rather than written.
//
//  2. THE ASSIGNED LORRY MUST STILL FIT (owner ruling, 29 Jul: refuse; never
//     silently swap a lorry). A change from 6 to 14 pallets on an 8-pallet
//     truck is refused with the failing guard named, and the admin frees the
//     lorry first. Auto-unassign was considered and rejected: it changes who is
//     driving what as a side effect of an approval.
//
//  3. ZONE POINTS ARE RE-SNAPSHOTTED. TripStop.zone_points/zone_code are
//     written at ASSIGNMENT, and finalization scores against that snapshot. The
//     stops here are deleted and recreated, so without this call the new rows
//     have NO snapshot at all (verified: zone_code comes back null) and the
//     per-drop pay evidence is simply missing. The client rule is that the ZONE
//     supplies the POINTS while the TRUCK supplies the RM-per-point RATE, so
//     the points must follow the destination — while the truck's rate snapshot
//     is deliberately NOT touched (rates lock at assignment; approving a change
//     does not re-price the lorry).
router.post(
  "/:id/change-request/:crId/approve",
  requireRole("admin"),
  validateBody(changeDecisionSchema),
  async (req, res, next) => {
    try {
      assertChangeRequestsEnabled();
      const { id, crId } = req.params;
      const { note, expected_version } = req.body as { note?: string; expected_version?: number };

      const cr = await prisma.tripChangeRequest.findFirst({ where: { id: crId, trip_id: id } });
      if (!cr) throw new ApiError(404, "CHANGE_REQUEST_NOT_FOUND", "Change request not found.");
      if (cr.status !== "pending") {
        throw new ApiError(409, "CHANGE_REQUEST_STATE_CHANGED", "This change request was already decided.");
      }
      if (expected_version !== undefined && cr.version !== expected_version) {
        throw new ApiError(409, "VERSION_CONFLICT", "This change request was updated by someone else. Refresh and try again.");
      }

      // Re-parse the stored payload through the SAME schema the requestor's
      // request was validated by. A stored payload is untrusted input.
      const stored = cr.payload as { input?: unknown; base?: unknown } | null;
      const parsed = updateTripSchema.safeParse(stored?.input);
      if (!parsed.success) {
        throw new ApiError(400, "CHANGE_REQUEST_INVALID", "This change request is no longer valid and cannot be applied. Reject it and ask for a new one.");
      }
      const input = parsed.data;

      const updated = await prisma.$transaction(async (tx) => {
        await lockTripRow(tx, id);
        const trip = await tx.trip.findUnique({ where: { id }, include: changeRequestTripInclude });
        if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
        if (trip.status !== "assigned") {
          throw new ApiError(409, "TRIP_STATE_CHANGED", "This booking is no longer assigned — the change cannot be applied. Reject the request.");
        }

        // STALENESS. Refuse to apply a proposal written against a different
        // version of this booking — see editableTripFingerprint.
        if (typeof stored?.base === "string" && editableTripFingerprint(trip) !== stored.base) {
          throw new ApiError(
            409,
            "CHANGE_REQUEST_STALE",
            "This booking has changed since the request was sent, so applying it would undo those changes. Reject it and ask for a new request."
          );
        }

        const { effectiveCargo, changeNote } = await validateTripEdit(trip, input);
        if (changeNote === null) {
          throw new ApiError(400, "NO_CHANGES", "This request no longer changes anything.");
        }

        // (2a) MOVING THE BOOKING TO A DIFFERENT DAY is refused while a lorry is
        // assigned. The assign path validates a date against the truck's
        // capacity FOR THAT DAY, roadworthiness, the scheduling-conflict buffer
        // and the driver's leave — none of which this route re-runs. Approving a
        // date change here would put a driver and lorry on a second booking that
        // day, possibly on a day he is on leave, with no warning. Same shape as
        // the overload refusal below and the same owner ruling behind it: never
        // silently change who is driving what.
        const dayBefore = mytDateKey(trip.pickup_datetime);
        const dayAfter = mytDateKey(input.pickup_datetime);
        if (dayBefore !== dayAfter) {
          throw new ApiError(
            409,
            "PICKUP_DAY_CHANGED",
            `This change moves the booking from ${dayBefore} to ${dayAfter}. Unassign the lorry first, then approve — the booking will be dispatched again for the new day.`
          );
        }

        // (2b) The assigned lorry must still fit — using the SAME maths the
        // manual assign uses, not a bare max_pallets compare. A truck's
        // capacity is what is left after its other committed load that day
        // (in_progress cargo is physically aboard; other assigned trips occupy
        // it on their own pickup day). Comparing against max_pallets alone let
        // an approval push 27 pallet-equivalents onto a 14-pallet lorry.
        if (trip.truck_plate && !trip.is_external) {
          const pickupDay = mytDayBoundsForKey(dayAfter)!;
          const truck = await tx.truck.findUnique({
            where: { plate: trip.truck_plate },
            include: {
              trips: {
                where: {
                  id: { not: id },
                  OR: [
                    { status: "in_progress" },
                    { status: "assigned", pickup_datetime: { gte: pickupDay.start, lt: pickupDay.end } },
                  ],
                },
                select: { cargo_details: { select: { pallet_type: true, quantity: true, estimated_pallets: true } } },
              },
            },
          });
          // A missing truck row on an assigned trip is not "fits" — refuse
          // rather than skip the guard.
          if (!truck) throw new ApiError(404, "TRUCK_NOT_FOUND", "The assigned truck no longer exists. Unassign the lorry first.");
          const needed = palletEquivalents(effectiveCargo);
          const currentLoad = truck.trips.reduce((sum, t) => sum + palletEquivalents(t.cargo_details), 0);
          if (currentLoad + needed > truck.max_pallets) {
            throw new ApiError(
              409,
              "TRUCK_OVERLOADED",
              `${truck.plate} holds ${truck.max_pallets} pallets and already carries ${currentLoad}. This change of ${needed} would total ${currentLoad + needed}. Unassign the lorry first, then approve — the booking will be dispatched again.`
            );
          }
        }

        // Claim the request FIRST: write-once, so two admins racing approve
        // cannot both apply the payload.
        const claimed = await tx.tripChangeRequest.updateMany({
          where: { id: crId, status: "pending" },
          data: {
            status: "approved",
            decided_by: req.user!.id,
            decided_at: new Date(),
            decision_note: note?.trim() || null,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          throw new ApiError(409, "CHANGE_REQUEST_STATE_CHANGED", "This change request was already decided. Refresh and try again.");
        }

        await tx.trip.update({
          where: { id },
          data: { route_type_id: input.route_type_id, pickup_datetime: input.pickup_datetime },
        });
        // An assigned booking's stops carry no arrival, POD or history refs
        // (those start at in_progress), so a wholesale replace is safe — but
        // they DO carry the assignment-time zone snapshot, which is why (3)
        // below is mandatory.
        // CARRY THE ASSIGNMENT-ERA SNAPSHOT FORWARD. The stop rows are replaced
        // wholesale, but a destination the requestor did NOT touch must keep the
        // points it was locked to at assignment — "running trips keep the old
        // rate" (3 Jul). Re-pricing every stop here meant a pickup-TIME change
        // silently re-rated untouched drops against today's rates and today's
        // consignee zones: a staged 6->9 point edit turned RM44 into RM77, and a
        // consignee zone correction turned RM44 into RM11 for a driver still
        // driving to Ipoh.
        const priorSnapshot = new Map(
          trip.stops.map((s) => [s.consignee_id, { zone_code: s.zone_code, zone_points: s.zone_points }])
        );
        await tx.tripStop.deleteMany({ where: { trip_id: id } });
        await tx.tripStop.createMany({
          data: normalizeStopSequences(input.stops).map((s) => {
            const carried = priorSnapshot.get(s.consignee_id);
            return {
              trip_id: id,
              consignee_id: s.consignee_id,
              sequence: s.sequence,
              // null for a genuinely NEW destination — priced just below.
              zone_code: carried?.zone_code ?? null,
              zone_points: carried?.zone_points ?? null,
            };
          }),
        });
        if (input.cargo_details !== undefined) {
          await tx.cargoDetail.deleteMany({ where: { trip_id: id } });
          await tx.cargoDetail.createMany({
            data: input.cargo_details.map((c) => ({ ...withCanonicalCargoSize(c), trip_id: id })),
          });
        }

        // (3) MANDATORY, and ONLY for destinations that are genuinely new: a
        // new stop has no snapshot at all until this runs, and finalization
        // scores against the snapshot. Carried-forward stops are skipped so
        // their assignment-era lock survives (see priorSnapshot above).
        //
        // A destination ADDED by this change takes the trip's ASSIGNMENT era,
        // not today's (owner ruling, 29 Jul 2026): consistency WITHIN a trip
        // beats matching a fresh assignment. Otherwise one approval could leave
        // a trip carrying two stops priced from two different rate eras, and
        // nobody reading the pay breakdown could tell why.
        //
        // The instant comes from the trip's own history. Falls back to now only
        // for a trip with no recorded assignment (pre-history rows) — the same
        // answer as before this ruling, and the only honest default.
        const assignedEvent = await tx.tripStatusHistory.findFirst({
          where: { trip_id: id, event: { in: ["assigned", "reassigned"] } },
          orderBy: { created_at: "desc" },
          select: { created_at: true },
        });
        await snapshotStopZonePoints(tx, id, {
          onlyUnsnapshotted: true,
          era: assignedEvent?.created_at,
        });

        await tx.auditLog.create({
          data: { user_id: req.user!.id, action: `trip.change_request_approved: ${changeNote}`, table_name: "Trip", record_id: id },
        });
        await recordTripEvent(tx, { tripId: id, event: "edited", actorId: req.user!.id, note: `Change approved — ${changeNote}` });
        return changeNote;
      });

      // Best-effort: tell the requestor their change went through.
      try {
        const trip = await prisma.trip.findUnique({ where: { id }, select: { ticket_number: true, requestor: { select: { expo_push_token: true } } } });
        await sendPushNotifications([trip?.requestor.expo_push_token], {
          title: "Change approved",
          body: `Your change to ${trip?.ticket_number ?? "your booking"} was approved — ${updated}`,
          data: { type: "change_request_approved", tripId: id },
        });
      } catch (err) {
        console.error("Change-request requestor notify failed:", err);
      }

      const fresh = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      res.json(fresh);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/abort — admin aborts an IN-PROGRESS trip (de-orphan) ──
// The only exit for an in_progress trip: unassign/reassign are `assigned`-only
// and cancel is pending/approved-only, so a trip whose driver must be removed
// (departed / incapacitated) is otherwise stranded in_progress forever — pay
// never finalizes and the truck's capacity never frees. This is also what the
// disable guard (PATCH /users/:id/approve → DRIVER_ON_ACTIVE_TRIP) points the
// admin to.
//
// Money (partial-pay rule, Mr. Teh 28 Jul 2026 — "yes keep the pay for those
// 3"): stops already DELIVERED keep their pay. An abort with ≥1 delivered stop
// therefore does NOT cancel outright — it proposes the incentive over the
// delivered stops only and flips the trip in_progress → pending_approval, the
// SAME approval lane a fully-delivered trip takes (admin validates the PODs,
// may edit the amount with a reason, approval → completed sets the payable
// incentive_final). Payroll and every earnings read stay keyed on `completed`
// alone — no money-read surface widens. With ZERO delivered stops the old
// behaviour stands: abort → `cancelled`, no pay (Q2b: breakdown → no pay for
// unreached stops). Either way the truck frees (neither `cancelled` nor
// `pending_approval` occupies capacity). Admin-only.
const abortTripSchema = z.object({ reason: z.string().max(500).optional() });

router.patch("/:id/abort", requireRole("admin"), validateBody(abortTripSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };

    const trip = await prisma.trip.findUnique({
      where: { id },
      select: { id: true, status: true, open_exception_id: true },
    });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }
    if (trip.status !== "in_progress") {
      throw new ApiError(
        400,
        "INVALID_STATUS",
        "Only an in-progress trip can be aborted. Use unassign or reassign for a scheduled trip, or cancel for one not yet assigned."
      );
    }
    // Lifecycle isolation (Phase 1 hardening): an OPEN exception blocks abort /
    // capacity release. This is the friendly up-front error; the authoritative
    // check is re-done under the trip lock below.
    //
    // ⚠ KEYED ON THE EXCEPTION, NOT ON Trip.open_exception_id. That pointer now
    // means "an exception is BLOCKING this trip", and a driver who taps
    // Continue clears it while leaving the report OPEN. Reading the pointer
    // here would let an admin abort a trip whose failed stop has not been
    // adjudicated yet — destroying pay the client has already ruled is owed
    // (R3 Q11(a) "Same rate paid, although not delivered"): the trip cancels
    // for RM0, and a later Verify + Resume silently pays nothing because
    // finalization only runs on an in_progress trip. RM52 on a single Ipoh
    // drop, RM78 on a 2-stop run, with a 200 on every request.
    if (await hasOpenException(prisma, id)) {
      throw new ApiError(409, "EXCEPTION_OPEN", "Resolve the open exception before aborting this trip.");
    }

    // Everything under the trip-row lock, with every value RE-READ under it —
    // the delivered branch locks the same row, so an abort can never interleave
    // with a driver's delivered write (the 0-delivered decision below would
    // otherwise race a first delivery into an unpaid cancel).
    await prisma.$transaction(async (tx) => {
      await lockTripRow(tx, id);
      const t2 = await tx.trip.findUnique({ where: { id }, include: { truck: true } });
      if (!t2) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      if (t2.status !== "in_progress") {
        throw new ApiError(
          409,
          "TRIP_STATE_CHANGED",
          "This trip just changed state (it may have completed). Refresh and try again."
        );
      }
      // Authoritative check, under the row lock. Same reasoning as above: an
      // OPEN report blocks the abort whether or not it is currently blocking
      // the driver. The report route takes this same lock, so nothing can open
      // one between here and the CAS.
      if (await hasOpenException(tx, id)) {
        throw new ApiError(409, "EXCEPTION_OPEN", "Resolve the open exception before aborting this trip.");
      }

      // EARNING stops, not merely delivered ones: a trip whose stops were all
      // reached-but-undeliverable and adjudicated still owes pay (R3 Q11(a)),
      // so it must take the approval lane rather than cancelling unpaid.
      //
      // Named `earningCount`, NOT `deliveredCount` — it is no longer a count of
      // deliveries, and the audit strings below must not claim it is.
      const earningCount = await tx.tripStop.count({
        where: { trip_id: id, OR: [{ status: "delivered" }, SETTLED_UNDELIVERED_WHERE] },
      });
      const deliveredCount = await tx.tripStop.count({
        where: { trip_id: id, status: "delivered" },
      });

      if (earningCount === 0) {
        // Nothing delivered → the original abort: cancelled, no pay (breakdown /
        // never-reached stops don't pay — 16 Jul + R1-Q2b).
        // Status-guarded CAS: under the lock this cannot lose to a delivery, but
        // the guard stays as defence in depth.
        const aborted = await abortActiveTrip(tx, id);
        if (!aborted) {
          throw new ApiError(
            409,
            "TRIP_STATE_CHANGED",
            "This trip just changed state (it may have completed). Refresh and try again."
          );
        }
        await tx.auditLog.create({
          data: {
            user_id: req.user!.id,
            action: `trip.aborted${reason ? ` — ${reason}` : ""}`,
            table_name: "Trip",
            record_id: id,
          },
        });
        await recordTripEvent(tx, { tripId: id, event: "cancelled", actorId: req.user!.id });
        return;
      }

      // ≥1 delivered stop → partial pay (Mr. Teh 28 Jul 2026): score the
      // DELIVERED stops exactly as a full delivery would (same engine, same
      // ledger, same snapshots) and send the trip down the normal approval
      // lane. The undelivered stops keep their pending/arrived status — the
      // per-stop record stays truthful about what was and wasn't delivered.
      if (!t2.driver_id) {
        // An in_progress trip always has a driver; loud guard, never silent pay.
        throw new ApiError(409, "TRIP_STATE_CHANGED", "This trip has no driver attached. Refresh and try again.");
      }
      const totalStops = await tx.tripStop.count({ where: { trip_id: id } });
      const proposedAmount = await proposeDeliveredStopsIncentive(tx, t2, t2.driver_id);
      if (proposedAmount === null) {
        throw new ApiError(
          409,
          "TRIP_STATE_CHANGED",
          "This trip just changed state (it may have completed). Refresh and try again."
        );
      }
      await tx.auditLog.create({
        data: {
          user_id: req.user!.id,
          // Both numbers, because they can differ: a stop can EARN without
          // being delivered (R3 Q11(a)). "3/5 stops delivered" for a trip that
          // delivered 1 and had 2 adjudicated failures is a false audit record.
          action: `trip.aborted_partial (${earningCount}/${totalStops} stops earning, ${deliveredCount} delivered — RM${proposedAmount} proposed for approval)${reason ? ` — ${reason}` : ""}`,
          table_name: "Trip",
          record_id: id,
        },
      });
      await recordTripEvent(tx, {
        tripId: id,
        event: "cancelled",
        actorId: req.user!.id,
        note: `Aborted after ${earningCount}/${totalStops} stops (${deliveredCount} delivered) — pay awaiting approval`,
      });
    });

    const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
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

/**
 * Trip statuses in which the POD is FROZEN. One list, two uses in the route
 * below — the cheap pre-upload guard and the atomic re-check in the write — so
 * the two cannot drift into disagreeing about what "finalized" means.
 */
const POD_LOCKED_STATUSES = ["pending_approval", "completed", "cancelled"] as const;

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
      // Images ONLY. A POD is proof of a live event at the delivery point and it
      // gates pay; an arbitrary file must not be able to stand in for the photo.
      // It is also what makes f_auto safe on POD delivery URLs (lib/podPhotos).
      assertMimetype(req.file, IMAGE_MIMETYPES, "A proof-of-delivery photo");

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

      // POD lock — mirror the write-once pay pattern: once the trip's delivery
      // is recorded its proof of delivery is frozen, so a re-upload can't
      // overwrite the evidence the incentive was proposed/paid against. This
      // covers `pending_approval` (POD-approval gate, 16 Jul 2026): the POD is
      // exactly what the admin approves against, so it must not change while the
      // trip awaits sign-off — as well as `completed` (approved/paid) and
      // `cancelled`. Checked BEFORE any Cloudinary call so a locked trip costs
      // no upload. The offline outbox treats this 409 as "already done" for the
      // photo step (podOutboxCore PHOTO_STEP_ALREADY_CODES), so a stale replay
      // is harmless.
      //
      // This is the CHEAP check. It is not the guarantee — the trip can still
      // flip while the upload is in flight, so the write below re-checks the
      // same list atomically.
      if (POD_LOCKED_STATUSES.includes(trip.status as (typeof POD_LOCKED_STATUSES)[number])) {
        throw new ApiError(
          409,
          "POD_LOCKED",
          "This trip is finalized — its proof of delivery can no longer be changed."
        );
      }

      // Authenticated (private) upload: the delivery URL 401s without a signature,
      // so it's no longer publicly enumerable by ticket number. We store the
      // public_id (signed on read) AND the authenticated URL in pod_photo — the
      // latter keeps the delivered-gate (isDocumentationComplete) unchanged; it
      // is not publicly accessible even if a serialization step were missed.
      const { url, publicId } = await uploadBuffer(req.file.buffer, "uwc/pod", {
        type: "authenticated",
        publicId: `${trip.ticket_number}-stop-${stop.sequence}`,
      });

      // DEVICE capture time, optional. Sent by the offline outbox (where the
      // server's own receipt is the REPLAY instant, hours late) and by the
      // online path for consistency. Evidence only — never read by pay.
      //
      // Two ways it becomes NULL rather than wrong: unparseable, or LATER than
      // our own receipt. A POD cannot be photographed after it arrives, so a
      // future value means a broken device clock, and a confident wrong time on
      // the field kept for disputes is worse than no time at all.
      const receivedAt = new Date();
      const claimedRaw = typeof req.body?.captured_client_at === "string" ? req.body.captured_client_at : null;
      const claimed = claimedRaw ? new Date(claimedRaw) : null;
      const capturedClientAt =
        claimed && !Number.isNaN(claimed.getTime()) && claimed.getTime() <= receivedAt.getTime()
          ? claimed
          : null;

      // RE-CHECK THE LOCK IN THE WRITE ITSELF, not just in the guard above.
      // Between that guard's read and this write we do a Cloudinary round-trip
      // (hundreds of ms on a 500KB photo), and the trip can flip to
      // pending_approval in that window — the driver taps Delivered on the last
      // stop, or an offline outbox flushes one. The old unconditional update
      // then rewrote the POD, and now its timestamp, on a stop the admin's
      // approval queue was already rendering.
      //
      // It mattered less before this commit: publicId is deterministic
      // (`${ticket}-stop-${sequence}`), so a late write stored a byte-identical
      // URL and was invisible. pod_uploaded_at is the first field whose value
      // actually differs, and it is the field kept as dispute evidence.
      //
      // Same shape as proposeTripIncentiveOnce (services/tripCompletion.ts): put
      // the status in the WHERE and require count === 1.
      const written = await prisma.tripStop.updateMany({
        where: { id: stopId, trip: { status: { notIn: [...POD_LOCKED_STATUSES] } } },
        data: {
          pod_photo: url,
          pod_public_id: publicId,
          do_uploaded: true,
          // IM6, the PAIR. `pod_uploaded_at` is the SERVER receipt — immutable,
          // not settable by the device that is a party to any dispute it
          // settles. For an offline-queued POD it is the REPLAY instant (a photo
          // taken at 16:45 with no signal and flushed at 19:10 reads 19:10), so
          // `pod_captured_client_at` carries what the DEVICE says beside it.
          //
          // Same shape as TripException: reported_at (server) beside
          // client_reported_at (device). Read the server one for anything that
          // must be trustworthy; show the device one as device-reported.
          pod_uploaded_at: receivedAt,
          pod_captured_client_at: capturedClientAt,
        },
      });
      if (written.count !== 1) {
        throw new ApiError(
          409,
          "POD_LOCKED",
          "This trip is finalized — its proof of delivery can no longer be changed."
        );
      }
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

// ── POST /trips/:id/stops/:stopId/k2 — driver uploads the Borang K2 document ──
//
// Mr. Teh R1 Q6: for a K2-zone stop the driver must UPLOAD the actual customs
// form (not a tick); the admin validates it at the existing POD/incentive
// approval. Same authenticated-Cloudinary pipeline + finalize-lock as the POD
// upload. Sets k2_photo/k2_public_id, which the K2 delivery gate keys on.
router.post(
  "/:id/stops/:stopId/k2",
  requireRole("driver"),
  upload.single("photo"),
  async (req, res, next) => {
    try {
      const { id, stopId } = req.params;
      if (!req.file) {
        throw new ApiError(400, "NO_FILE", "A file is required (field name 'photo').");
      }
      // Customs paperwork genuinely arrives as a PDF, so this route accepts one.
      // ⚠ That is why K2 delivery URLs use signedK2Url (no f_auto) rather than
      // signedPodUrl — the two are NOT interchangeable any more.
      assertMimetype(req.file, DOCUMENT_MIMETYPES, "The customs document");
      const trip = await prisma.trip.findUnique({ where: { id }, include: { stops: true } });
      if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      if (trip.driver_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
      }
      const stop = trip.stops.find((s) => s.id === stopId);
      if (!stop) throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");

      // Finalize-lock — same as POD: once the trip is proposed/paid/cancelled its
      // approved documents are frozen.
      if (trip.status === "pending_approval" || trip.status === "completed" || trip.status === "cancelled") {
        throw new ApiError(409, "POD_LOCKED", "This trip is finalized — its documents can no longer be changed.");
      }

      // ⚠ resource_type stays "image" — do NOT "fix" this to "auto".
      // Cloudinary classifies a PDF as resource_type IMAGE, so "image" accepts
      // one perfectly well. What it ALSO does is reject bytes Cloudinary cannot
      // decode, and that rejection is load-bearing: K2 gates Delivered and
      // therefore pay. Under "auto" an undecodable file falls through to `raw`
      // and stores SUCCESSFULLY, so `k2_photo` is set, the gate opens, and the
      // stored evidence is an asset the signed /image/ URL can never render —
      // an open gate over an unopenable document. K2 has no resource_type
      // column to sign from, so it cannot recover the way documents can.
      const { url, publicId } = await uploadBuffer(req.file.buffer, "uwc/k2", {
        type: "authenticated",
        publicId: `${trip.ticket_number}-stop-${stop.sequence}-k2`,
      });
      await prisma.tripStop.update({
        where: { id: stopId },
        data: { k2_photo: url, k2_public_id: publicId },
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "stop.k2_uploaded", table_name: "TripStop", record_id: stopId },
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
      assertMimetype(req.file, DOCUMENT_MIMETYPES, "A document");

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

      // FINALIZE LOCK for the REQUESTOR. This route had no status guard at all,
      // so the owning requestor could attach paperwork to a trip that was
      // already delivered, paid or cancelled — the one place Mr. Teh's A19
      // matrix ("DELIVERED / CANCELLED → requestor cannot edit") leaked.
      //
      // The three statuses are not a new rule: they are exactly the POD and K2
      // finalize lock a few routes above (POD_LOCKED). Once a trip is proposed,
      // paid or cancelled its evidence is frozen, and paperwork appearing
      // against a settled trip is the same problem whichever door it came in.
      //
      // ADMINS ARE DELIBERATELY NOT BLOCKED: the same matrix grants them
      // "correct records with audit trail" at DELIVERED and "reopen if
      // necessary" at CANCELLED, and this route already writes an audit row for
      // every upload. Correcting the paperwork on a finished trip is the
      // clerical job the client asked for.
      if (
        isOwner &&
        (trip.status === "pending_approval" ||
          trip.status === "completed" ||
          trip.status === "cancelled")
      ) {
        throw new ApiError(
          409,
          "TRIP_FINALIZED",
          "This booking is finished — documents can no longer be added. Ask an admin if a record needs correcting."
        );
      }

      // Authenticated (private) upload: the delivery URL 401s without a
      // signature, so DO/invoice paperwork is no longer publicly accessible.
      // Store the handles; the trips-router serializer signs file_url on read.
      const { url, publicId, resourceType, format } = await uploadBuffer(
        req.file.buffer,
        "uwc/documents",
        { type: "authenticated", resourceType: "auto" }
      );

      await prisma.tripDocument.create({
        data: {
          trip_id: id,
          type,
          file_url: url,
          public_id: publicId,
          resource_type: resourceType,
          format,
        },
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
        // DG-R1 (best-effort, outside the tx): approve/reject/cancel/final-
        // delivery all push the requestor, but STARTING pushed nothing — the
        // requestor never learned their delivery left the yard.
        if (updated) {
          const requestorDevice = await prisma.user.findUnique({
            where: { id: updated.requestor_id },
            select: { expo_push_token: true },
          });
          await sendPushNotifications([requestorDevice?.expo_push_token], {
            title: "Delivery on the way",
            body: `Your delivery ${updated.ticket_number} has started — the driver is on the way`,
            data: { type: "trip_started", tripId: id },
          });
        }
        res.json(updated);
        return;
      }

      // arrived / delivered both act on a specific stop. No stop_id → default
      // to the first OUTSTANDING stop, so single-stop trips don't need to name
      // it. "Outstanding" excludes settled paid-undelivered stops (R3 Q11(a)):
      // an older client that omits stop_id would otherwise target a stop the
      // admin already closed and paid, and hit a hard DOCUMENTATION_INCOMPLETE
      // that blocks every later delivery on the trip.
      const stop = stop_id
        ? trip.stops.find((s) => s.id === stop_id)
        : trip.stops.find((s) => s.status !== "delivered" && !isStopAdjudicated(s));
      if (!stop) {
        throw new ApiError(400, "STOP_NOT_FOUND", "No matching stop found for this trip.");
      }

      if (action === "arrived") {
        // Serialize with exception-open (lib/tripLock): lock the Trip row, then
        // RE-READ status / driver / open_exception_id / stop status under the lock
        // (never the preloaded values). Stop mutation + audit + timeline commit in
        // ONE transaction, so a report can never interleave into an inconsistent
        // state. An OPEN exception freezes Arrived (GPS tracking continues — the
        // trip stays in_progress).
        await prisma.$transaction(async (tx) => {
          await lockTripRow(tx, id);
          const t2 = await tx.trip.findUnique({ where: { id }, select: { status: true, driver_id: true, open_exception_id: true } });
          if (!t2) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
          if (t2.driver_id !== req.user!.id) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
          if (t2.open_exception_id) throw new ApiError(409, "EXCEPTION_OPEN", "Resolve the open exception before continuing this trip.");
          const stop2 = await tx.tripStop.findUnique({ where: { id: stop.id }, select: { status: true } });
          if (!stop2) throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
          assertStopArrivable({ status: t2.status }, stop2);
          await tx.tripStop.update({ where: { id: stop.id }, data: { status: "arrived", arrived_at: new Date() } });
          await tx.auditLog.create({ data: { user_id: req.user!.id, action: "stop.arrived", table_name: "TripStop", record_id: stop.id } });
          await recordTripEvent(tx, { tripId: id, event: "stop_arrived", stopId: stop.id, actorId: req.user!.id });
          await testHook("arrived.beforeCommit");
        });
        const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
        res.json(updated);
        return;
      }

      // action === "delivered"
      // Serialize with exception-open (lib/tripLock): the stop mutation AND — for
      // the last stop — the incentive proposal + pending_approval flip run in ONE
      // locked transaction, so there is NO gap where the stop is committed
      // delivered but an exception can open before finalization. Every value is
      // RE-READ under the lock (never the preloaded trip/stop). The incentive math
      // is byte-for-byte unchanged — only the transaction boundary + lock are new.
      const finalizedTrip = await prisma.$transaction(async (tx) => {
        await lockTripRow(tx, id);
        const t2 = await tx.trip.findUnique({ where: { id }, include: { truck: true } });
        if (!t2) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
        if (t2.driver_id !== req.user!.id) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
        // An OPEN exception blocks delivery + finalization: no final delivery,
        // incentive proposal or pending_approval may occur while one is open.
        if (t2.open_exception_id) throw new ApiError(409, "EXCEPTION_OPEN", "Resolve the open exception before delivering this stop.");
        const stop2 = await tx.tripStop.findUnique({ where: { id: stop.id } });
        if (!stop2) throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
        // A stop can be delivered only while the trip is out, and only once.
        assertStopDeliverable({ status: t2.status }, stop2);
        const consigneeForGate = await tx.consignee.findUnique({ where: { id: stop2.consignee_id } });
        if (!consigneeForGate) throw new ApiError(400, "CONSIGNEE_NOT_FOUND", "Consignee for this stop no longer exists.");
        if (!isDocumentationComplete(stop2, consigneeForGate.zone_code, consigneeForGate.area)) {
          throw new ApiError(400, "DOCUMENTATION_INCOMPLETE", "The POD photo (and a customs document, for destinations that need one) must be uploaded before marking delivered.");
        }

        await tx.tripStop.update({ where: { id: stop.id }, data: { status: "delivered", delivered_at: new Date() } });
        await tx.auditLog.create({ data: { user_id: req.user!.id, action: "stop.delivered", table_name: "TripStop", record_id: stop.id } });
        await recordTripEvent(tx, { tripId: id, event: "stop_delivered", stopId: stop.id, actorId: req.user!.id });

        // OUTSTANDING stops — not delivered AND not settled as paid-undelivered.
        // Without the NOT, a stop the admin resolved under R3 Q11(a) would sit
        // "not delivered" forever, the trip could never finalize, and the pay it
        // just earned would never propose.
        const remainingStops = await tx.tripStop.count({
          // ADJUDICATED, not SETTLED: a stop whose pay a rejection vetoed is still
          // CLOSED OUT. Using the pay predicate here made it outstanding again
          // and the trip never finalized. See undeliveredPay's two-predicate note.
          where: { trip_id: id, status: { not: "delivered" }, NOT: ADJUDICATED_UNDELIVERED_WHERE },
        });
        if (remainingStops > 0) {
          // More stops to go — no money moves. (Barrier: a report may still open
          // against the remaining trip after this NON-final delivery commits.)
          await testHook("delivered.beforeCommit");
          return false;
        }

        // Last stop delivered — finalize IN THE SAME transaction. The scoring +
        // write-once CAS live in proposeDeliveredStopsIncentive (shared with
        // the abort partial-pay path); every stop is "delivered" at this point,
        // so its delivered-only filter matches the whole trip.
        const proposed = await proposeDeliveredStopsIncentive(tx, t2, req.user!.id);
        if (proposed === null) throw new ApiError(409, "TRIP_ALREADY_FINALIZED", "This trip has already been delivered and its incentive proposed.");
        await tx.auditLog.create({ data: { user_id: req.user!.id, action: "trip.delivered_pending_approval", table_name: "Trip", record_id: id } });
        await testHook("delivered.beforeCommit");
        return true;
      });

      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });

      // Notifications (best-effort, OUTSIDE the tx) — only when the trip finalized.
      if (finalizedTrip) {
        const adminsToNotify = await prisma.user.findMany({
          where: { role: "admin", status: "active", expo_push_token: { not: null } },
          select: { expo_push_token: true },
        });
        await sendPushNotifications(adminsToNotify.map((a) => a.expo_push_token), {
          title: "Trip awaiting approval",
          body: `Trip ${updated?.ticket_number ?? ""} was delivered — approve the POD to release the incentive`,
          data: { type: "pending_approval", tripId: id },
        });
        if (updated) {
          const requestorDevice = await prisma.user.findUnique({ where: { id: updated.requestor_id }, select: { expo_push_token: true } });
          await sendPushNotifications([requestorDevice?.expo_push_token], {
            title: "Delivery complete",
            body: `Your booking ${updated.ticket_number} has been delivered`,
            data: { type: "trip_delivered", tripId: id },
          });
        }
      } else if (updated) {
        // NON-final stop on a multi-drop trip (DG-R1's remaining half — the
        // finalize push above already existed): the requestor used to hear
        // nothing until the LAST drop. Best-effort, outside the tx.
        const deliveredStop = updated.stops.find((s) => s.id === stop.id);
        const requestorDevice = await prisma.user.findUnique({
          where: { id: updated.requestor_id },
          select: { expo_push_token: true },
        });
        await sendPushNotifications([requestorDevice?.expo_push_token], {
          title: "Stop delivered",
          body: `${deliveredStop?.consignee?.company_name ?? "A stop"} was delivered (${updated.ticket_number})`,
          data: { type: "stop_delivered", tripId: id },
        });
      }

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/approve-incentive — admin approves a delivered trip's POD ──
// Mr. Teh 16 Jul 2026 (TEST QUERY item 9): "After driver complete the delivery,
// they will have to upload the proof of delivery (the chop sign return copy on
// DO), then together with the incentive rate, submit to admin for approval,
// admin also can edit the final rate prior approval." This is the point of pay:
// the incentive was PROPOSED at delivery (pending_approval); approving here flips
// the trip to `completed` and sets the payable `incentive_final`. Editing the
// amount requires a reason; the original proposal (`incentive_earned`) is kept.
const approveIncentiveSchema = z.object({
  final_amount: z.number().min(0).optional(), // omit → confirm the proposal as-is
  reason: z.string().optional(), // required iff final_amount differs from the proposal
});
router.patch(
  "/:id/approve-incentive",
  requireRole("admin"),
  validateBody(approveIncentiveSchema),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const { final_amount, reason } = req.body as { final_amount?: number; reason?: string };
      const trip = await prisma.trip.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          incentive_earned: true,
          ticket_number: true,
          driver: { select: { expo_push_token: true } },
        },
      });
      if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      assertIncentiveApprovable(trip, final_amount, reason);

      const proposedAmount = Number(trip.incentive_earned ?? 0);
      const approved = await approveTripIncentiveOnce(prisma, id, {
        proposedAmount,
        finalAmount: final_amount,
        reason,
        adminId: req.user!.id,
        approvedAt: new Date(),
      });
      if (!approved) {
        throw new ApiError(409, "TRIP_STATE_CHANGED", "This trip is no longer awaiting approval.");
      }

      const finalAmount = final_amount === undefined ? proposedAmount : Math.round(final_amount * 100) / 100;
      const edited = Math.round(finalAmount * 100) !== Math.round(proposedAmount * 100);
      await prisma.auditLog.create({
        data: {
          user_id: req.user!.id,
          action: edited
            ? `trip.incentive_approved (edited RM${proposedAmount}→RM${finalAmount}: ${reason})`
            : "trip.incentive_approved",
          table_name: "Trip",
          record_id: id,
        },
      });
      await recordTripEvent(prisma, {
        tripId: id,
        event: "incentive_approved",
        actorId: req.user!.id,
        note: edited ? `Rate edited to RM${finalAmount}` : undefined,
      });
      // The trip reaches its terminal `completed` state only now (approval is
      // what completes it under the POD-approval gate) — record it so the
      // timeline's completed milestone lands on the approval instant.
      await recordTripEvent(prisma, {
        tripId: id,
        event: "completed",
        actorId: req.user!.id,
      });
      await sendPushNotifications([trip.driver?.expo_push_token], {
        title: "Incentive approved",
        body: `Trip ${trip.ticket_number}: RM${finalAmount} approved`,
        data: { type: "incentive_approved", tripId: id },
      });

      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
