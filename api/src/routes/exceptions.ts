import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { isUniqueViolation } from "../lib/prismaErrors";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { validateBody } from "../middleware/validate";
import { upload } from "../lib/upload";
import { uploadBuffer } from "../lib/cloudinary";
import { exceptionsEnabled } from "../lib/featureFlags";
import {
  EXCEPTION_EVIDENCE_FOLDER,
  serializeException,
  type ExceptionAudience,
} from "../lib/exceptionEvidence";
import {
  EXCEPTION_CATEGORIES,
  assertCanReport,
  assertVersion,
  allowedFromStates,
  nextExceptionState,
  stateAfterEvidence,
  type ExceptionActionTypeT,
  type ExceptionResolutionT,
} from "../services/exceptionWorkflow";

// ── Failed-delivery / exception workflow (Phase 1, feature-flagged) ───────────
// Mounted at /api/v1/trips (alongside the trips router). MONEY-FREE: this router
// never reads or writes an incentive/rate/finalization field, never changes
// Trip.status (it stays in_progress), and never releases capacity.
//
// Concurrency model (hardened): every state change is an ATOMIC compare-and-set —
// updateMany WHERE id + the read `version` + closed_at IS NULL + current_state IN
// (allowed) — requiring count === 1, with the action append + projection update +
// pointer clear all in ONE transaction. A CAS miss rolls the whole thing back and
// returns 409. Idempotency is payload-sensitive: the SAME operation UUID with the
// SAME semantics returns the original committed result; a REUSED UUID with a
// different actor/action/resolution/payload returns 409.
//
// Authorization ALWAYS precedes any aggregate exposure (including idempotent
// replays). Only ADMINS close/resolve an exception (verify/reject/resume/retry);
// drivers may only report and resubmit evidence.
const router = Router();

// Feature gate FIRST: while off, these routes 404 as if absent (reads + writes).
router.use((_req, _res, next) => {
  if (!exceptionsEnabled()) {
    next(new ApiError(404, "NOT_FOUND", "Not found."));
    return;
  }
  next();
});
router.use(requireAuth);

// Deterministic action/evidence ordering: (created_at, id) — id breaks same-instant
// ties so replay + timelines are stable.
const orderByCreatedThenId = [{ created_at: "asc" as const }, { id: "asc" as const }];
const exceptionInclude = {
  actions: { orderBy: orderByCreatedThenId },
  evidence: { orderBy: orderByCreatedThenId },
};

// ── Validation limits ────────────────────────────────────────────────────────
const MAX_REASON = 2000;
const MAX_NOTE = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(name: string, v: string | undefined): string {
  if (!v || !UUID_RE.test(v)) {
    throw new ApiError(400, "INVALID_OPERATION_ID", `${name} must be a valid UUID.`);
  }
  return v;
}
function validateGeo(lat: number | null, lng: number | null, accuracy: number | null): void {
  if (lat !== null && (lat < -90 || lat > 90)) throw new ApiError(400, "INVALID_GEO", "Latitude out of range.");
  if (lng !== null && (lng < -180 || lng > 180)) throw new ApiError(400, "INVALID_GEO", "Longitude out of range.");
  if (accuracy !== null && (accuracy < 0 || accuracy > 100000)) throw new ApiError(400, "INVALID_GEO", "Accuracy out of range.");
}

async function loadException(tripId: string, exId: string) {
  const exc = await prisma.tripException.findFirst({
    where: { id: exId, trip_id: tripId },
    include: exceptionInclude,
  });
  if (!exc) throw new ApiError(404, "EXCEPTION_NOT_FOUND", "Exception not found.");
  return exc;
}

async function reloadAndSend(res: import("express").Response, tripId: string, exId: string, audience: ExceptionAudience, status = 200) {
  const fresh = await loadException(tripId, exId);
  res.status(status).json({ exception: serializeException(fresh, audience) });
}

// Multipart text-field coercers.
function numField(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dateField(v: unknown): Date | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

// ── POST /:id/exception — driver reports an exception (multipart, photo required)
router.post("/:id/exception", requireRole("driver"), upload.single("photo"), async (req, res, next) => {
  try {
    const tripId = req.params.id;
    const driverId = req.user!.id;

    const category = strField(req.body.category);
    const reason = strField(req.body.reason);
    const clientOccurrenceId = requireUuid("client_occurrence_id", strField(req.body.client_occurrence_id));
    const clientActionId = requireUuid("client_action_id", strField(req.body.client_action_id));
    const clientEvidenceId = requireUuid("client_evidence_id", strField(req.body.client_evidence_id));
    const tripStopId = strField(req.body.trip_stop_id) ?? null;

    if (!category || !(EXCEPTION_CATEGORIES as readonly string[]).includes(category)) {
      throw new ApiError(400, "INVALID_CATEGORY", "A valid exception category is required.");
    }
    if (!reason) throw new ApiError(400, "REASON_REQUIRED", "A reason is required.");
    if (reason.length > MAX_REASON) throw new ApiError(400, "REASON_TOO_LONG", `Reason exceeds ${MAX_REASON} characters.`);
    if (!req.file) throw new ApiError(400, "EVIDENCE_REQUIRED", "A photo is required (field name 'photo').");

    const lat = numField(req.body.lat);
    const lng = numField(req.body.lng);
    const accuracy = numField(req.body.accuracy_m);
    validateGeo(lat, lng, accuracy);

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, status: true, driver_id: true },
    });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");

    // AUTHORIZATION FIRST — before any aggregate is exposed (incl. replay).
    if (trip.driver_id !== driverId) {
      throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
    }

    // Payload-sensitive idempotent replay: this occurrence already landed.
    const existing = await prisma.tripException.findUnique({
      where: { trip_id_client_occurrence_id: { trip_id: tripId, client_occurrence_id: clientOccurrenceId } },
    });
    if (existing) {
      if (existing.category !== category || existing.reason !== reason || existing.reported_by !== driverId || (existing.trip_stop_id ?? null) !== tripStopId) {
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
      }
      await reloadAndSend(res, tripId, existing.id, "full", 200);
      return;
    }

    // NEW report: trip must be in_progress.
    assertCanReport(trip, driverId);
    if (tripStopId) {
      const stop = await prisma.tripStop.findFirst({ where: { id: tripStopId, trip_id: tripId } });
      if (!stop) throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
    }
    // Cheap pre-check for a friendly error; the partial unique index is the atomic backstop.
    const openAlready = await prisma.tripException.findFirst({ where: { trip_id: tripId, closed_at: null }, select: { id: true } });
    if (openAlready) throw new ApiError(409, "EXCEPTION_ALREADY_OPEN", "This trip already has an open exception.");

    const { url, publicId } = await uploadBuffer(req.file.buffer, EXCEPTION_EVIDENCE_FOLDER, { type: "authenticated" });

    let excId: string;
    try {
      excId = await prisma.$transaction(async (tx) => {
        // The create itself is the atomic one-open guard (partial unique index on
        // trip_id WHERE closed_at IS NULL). A concurrent open → P2002 (caught below).
        const exc = await tx.tripException.create({
          data: {
            trip_id: tripId,
            trip_stop_id: tripStopId,
            client_occurrence_id: clientOccurrenceId,
            category: category as never,
            reason,
            reported_by: driverId,
            client_reported_at: dateField(req.body.client_at),
            current_state: "reported",
          },
        });
        // Cache pointer — also verifies in_progress atomically.
        const claim = await tx.trip.updateMany({
          where: { id: tripId, status: "in_progress", open_exception_id: null },
          data: { open_exception_id: exc.id },
        });
        if (claim.count !== 1) {
          throw new ApiError(409, "EXCEPTION_ALREADY_OPEN", "This trip already has an open exception, or is no longer in progress.");
        }
        const action = await tx.exceptionAction.create({
          data: {
            exception_id: exc.id,
            client_action_id: clientActionId,
            type: "report",
            actor_id: driverId,
            actor_role: "driver",
            lat, lng, accuracy_m: accuracy,
            client_at: dateField(req.body.client_at),
          },
        });
        await tx.exceptionEvidence.create({
          data: {
            exception_id: exc.id,
            action_id: action.id,
            client_evidence_id: clientEvidenceId,
            url, public_id: publicId,
            uploaded_by: driverId,
            captured_client_at: dateField(req.body.captured_client_at),
          },
        });
        await tx.auditLog.create({
          data: { user_id: driverId, action: `exception.reported (${category})`, table_name: "TripException", record_id: exc.id },
        });
        return exc.id;
      });
    } catch (err) {
      // Concurrent unique-key race: either the SAME occurrence committed (→ compare
      // + return the original), or a DIFFERENT exception is already open (→ 409).
      if (isUniqueViolation(err)) {
        const dupe = await prisma.tripException.findUnique({
          where: { trip_id_client_occurrence_id: { trip_id: tripId, client_occurrence_id: clientOccurrenceId } },
        });
        if (dupe) {
          if (dupe.category !== category || dupe.reason !== reason || dupe.reported_by !== driverId || (dupe.trip_stop_id ?? null) !== tripStopId) {
            throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
          }
          await reloadAndSend(res, tripId, dupe.id, "full", 200);
          return;
        }
        throw new ApiError(409, "EXCEPTION_ALREADY_OPEN", "This trip already has an open exception.");
      }
      throw err;
    }

    await reloadAndSend(res, tripId, excId, "full", 201);
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/exception/:exId/evidence — driver resubmits evidence (append-only)
router.post("/:id/exception/:exId/evidence", requireRole("driver"), upload.single("photo"), async (req, res, next) => {
  try {
    const { id: tripId, exId } = req.params;
    const driverId = req.user!.id;
    const clientEvidenceId = requireUuid("client_evidence_id", strField(req.body.client_evidence_id));
    if (!req.file) throw new ApiError(400, "EVIDENCE_REQUIRED", "A photo is required (field name 'photo').");

    // AUTHORIZATION FIRST.
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { driver_id: true } });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    if (trip.driver_id !== driverId) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");

    const exc = await loadException(tripId, exId);
    // Idempotent replay.
    const prior = exc.evidence.find((e) => e.client_evidence_id === clientEvidenceId);
    if (prior) {
      if (prior.uploaded_by !== driverId) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This evidence id was already used by someone else.");
      await reloadAndSend(res, tripId, exId, "full", 200);
      return;
    }
    // Never reopen a closed exception; more_evidence → reported for re-review.
    const nextState = stateAfterEvidence(exc.current_state as never);

    const { url, publicId } = await uploadBuffer(req.file.buffer, EXCEPTION_EVIDENCE_FOLDER, { type: "authenticated" });
    // The evidence_added action's operation id is server-derived from the evidence
    // id (namespaced), so it is unique per exception and not client-forgeable.
    const evidenceActionId = `ev:${clientEvidenceId}`;

    try {
      await prisma.$transaction(async (tx) => {
        // Atomic CAS: only advance if still at the version we read AND still open.
        const cas = await tx.tripException.updateMany({
          where: { id: exId, version: exc.version, closed_at: null },
          data: { current_state: nextState as never, version: { increment: 1 } },
        });
        if (cas.count !== 1) {
          throw new ApiError(409, "EXCEPTION_STATE_CHANGED", "This exception changed since you loaded it. Refresh and try again.");
        }
        const action = await tx.exceptionAction.create({
          data: {
            exception_id: exId,
            client_action_id: evidenceActionId,
            type: "evidence_added",
            actor_id: driverId,
            actor_role: "driver",
          },
        });
        await tx.exceptionEvidence.create({
          data: {
            exception_id: exId,
            action_id: action.id,
            client_evidence_id: clientEvidenceId,
            url, public_id: publicId,
            uploaded_by: driverId,
            captured_client_at: dateField(req.body.captured_client_at),
          },
        });
        await tx.auditLog.create({
          data: { user_id: driverId, action: "exception.evidence_added", table_name: "TripException", record_id: exId },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Concurrent same-evidence replay committed — return the original.
        await reloadAndSend(res, tripId, exId, "full", 200);
        return;
      }
      throw err;
    }
    await reloadAndSend(res, tripId, exId, "full", 201);
  } catch (err) {
    next(err);
  }
});

// ── Admin transitions (verify / reject / request-more-evidence / resume / resolve)
const reviewSchema = z.object({
  client_action_id: z.string().uuid(),
  note: z.string().max(MAX_NOTE).optional(),
  expected_version: z.number().int().min(0).optional(),
});

/** Atomic transition executor: payload-sensitive idempotency, version+state CAS,
 *  action append + projection + pointer clear in one transaction. */
async function applyTransition(opts: {
  tripId: string;
  exId: string;
  actorId: string;
  action: Exclude<ExceptionActionTypeT, "report" | "evidence_added">;
  clientActionId: string;
  note?: string;
  resolveWith?: ExceptionResolutionT;
  expectedVersion?: number;
}): Promise<void> {
  const exc = await loadException(opts.tripId, opts.exId);

  // Payload-sensitive idempotent replay: same op id + same semantics → no-op OK;
  // reused op id with different actor/action/resolution/note → 409.
  const prior = exc.actions.find((a) => a.client_action_id === opts.clientActionId);
  if (prior) {
    const same =
      prior.type === opts.action &&
      (prior.resolution ?? null) === (opts.resolveWith ?? null) &&
      prior.actor_id === opts.actorId &&
      (prior.note ?? null) === (opts.note ?? null);
    if (!same) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
    return; // already applied
  }

  assertVersion(exc.version, opts.expectedVersion);
  const t = nextExceptionState(exc.current_state as never, opts.action, opts.resolveWith);
  const allowed = allowedFromStates(opts.action);

  try {
    await prisma.$transaction(async (tx) => {
      // Atomic CAS — id + read version + still-open + allowed source state. Two
      // admins racing the same version: exactly one gets count === 1.
      const cas = await tx.tripException.updateMany({
        where: { id: opts.exId, version: exc.version, closed_at: null, current_state: { in: allowed as never } },
        data: {
          current_state: t.state as never,
          resolution: t.resolution ?? undefined,
          resolved_at: t.closes ? new Date() : undefined,
          closed_at: t.closes ? new Date() : undefined,
          version: { increment: 1 },
        },
      });
      if (cas.count !== 1) {
        throw new ApiError(409, "EXCEPTION_STATE_CHANGED", "This exception changed since you loaded it. Refresh and try again.");
      }
      await tx.exceptionAction.create({
        data: {
          exception_id: opts.exId,
          client_action_id: opts.clientActionId,
          type: opts.action,
          resolution: t.resolution ?? null,
          actor_id: opts.actorId,
          actor_role: "admin",
          note: opts.note ?? null,
        },
      });
      // Closing releases the trip's one-open pointer. Trip.status UNCHANGED.
      if (t.closes) {
        await tx.trip.updateMany({ where: { id: opts.tripId, open_exception_id: opts.exId }, data: { open_exception_id: null } });
      }
      await tx.auditLog.create({
        data: {
          user_id: opts.actorId,
          action: `exception.${opts.action}${t.resolution ? ` (${t.resolution})` : ""}${opts.note ? `: ${opts.note}` : ""}`,
          table_name: "TripException",
          record_id: opts.exId,
        },
      });
    });
  } catch (err) {
    // Concurrent same-op replay committed → compare + return original / 409.
    if (isUniqueViolation(err)) {
      const fresh = await loadException(opts.tripId, opts.exId);
      const committed = fresh.actions.find((a) => a.client_action_id === opts.clientActionId);
      if (committed) {
        const same =
          committed.type === opts.action &&
          (committed.resolution ?? null) === (opts.resolveWith ?? null) &&
          committed.actor_id === opts.actorId &&
          (committed.note ?? null) === (opts.note ?? null);
        if (!same) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
        return;
      }
    }
    throw err;
  }
}

router.post("/:id/exception/:exId/request-more-evidence", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    if (!note || note.trim() === "") throw new ApiError(400, "NOTE_REQUIRED", "A note is required when requesting more evidence.");
    await applyTransition({ tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, action: "request_more_evidence", clientActionId: client_action_id, note, expectedVersion: expected_version });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

router.post("/:id/exception/:exId/verify", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    await applyTransition({ tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, action: "verify", clientActionId: client_action_id, note, expectedVersion: expected_version });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

router.post("/:id/exception/:exId/reject", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    if (!note || note.trim() === "") throw new ApiError(400, "NOTE_REQUIRED", "A note is required when rejecting.");
    await applyTransition({ tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, action: "reject", clientActionId: client_action_id, note, expectedVersion: expected_version });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

// Resume + Resolve are ADMIN-ONLY (owner decision): only admins close/resolve.
router.post("/:id/exception/:exId/resume", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    await applyTransition({ tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, action: "resume", clientActionId: client_action_id, note, resolveWith: "resume", expectedVersion: expected_version });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

const resolveSchema = reviewSchema.extend({ resolution: z.string().min(1) });
router.post("/:id/exception/:exId/resolve", requireRole("admin"), validateBody(resolveSchema), async (req, res, next) => {
  try {
    const { resolution, note, client_action_id, expected_version } = req.body as { resolution: string; note?: string; client_action_id: string; expected_version?: number };
    // nextExceptionState → assertResolutionExecutable refuses anything but retry.
    await applyTransition({ tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, action: "resolve", clientActionId: client_action_id, note, resolveWith: resolution as ExceptionResolutionT, expectedVersion: expected_version });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

// ── GET /:id/exception — current/latest exception (role-aware, requestor redacted)
router.get("/:id/exception", requireRole("driver", "admin", "requestor"), async (req, res, next) => {
  try {
    const tripId = req.params.id;
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { driver_id: true, requestor_id: true },
    });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");

    const role = req.user!.role;
    let audience: ExceptionAudience;
    if (role === "admin") audience = "full";
    else if (role === "driver" && trip.driver_id === req.user!.id) audience = "full";
    else if (role === "requestor" && trip.requestor_id === req.user!.id) audience = "redacted";
    else throw new ApiError(403, "FORBIDDEN", "You do not have access to this trip's exceptions.");

    const exc =
      (await prisma.tripException.findFirst({
        where: { trip_id: tripId, closed_at: null },
        include: exceptionInclude,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      })) ??
      (await prisma.tripException.findFirst({
        where: { trip_id: tripId },
        include: exceptionInclude,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      }));

    res.json({ exception: exc ? serializeException(exc, audience) : null });
  } catch (err) {
    next(err);
  }
});

export default router;
