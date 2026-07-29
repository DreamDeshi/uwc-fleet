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
import { lockTripRow } from "../lib/tripLock";
import { testHook } from "../lib/testHooks";
import { sha256Hex, reportFingerprint, evidenceFingerprint } from "../lib/exceptionFingerprint";
import {
  EXCEPTION_EVIDENCE_FOLDER,
  serializeException,
  type ExceptionAudience,
} from "../lib/exceptionEvidence";
import {
  EXCEPTION_CATEGORIES,
  assertVersion,
  allowedFromStates,
  nextExceptionState,
  stateAfterEvidence,
  type ExceptionActionTypeT,
  type ExceptionResolutionT,
} from "../services/exceptionWorkflow";

// ── Failed-delivery / exception workflow (Phase 1, feature-flagged) ───────────
// MONEY-FREE. Concurrency model:
//   • Trip-lifecycle serialization: opening a TripException and the Arrived/
//     Delivered mutations both take a Trip row lock (lib/tripLock) and RE-READ
//     status/driver/open_exception_id/stop under it — never a stale preloaded
//     value. So a report and a delivery can never interleave into an inconsistent
//     state (see routes/trips.ts for the Arrived/Delivered side).
//   • Every state change is an atomic version+state CAS requiring count === 1,
//     with the action append + projection + pointer clear in one transaction.
//   • Idempotency is payload-sensitive via SERVER-computed fingerprints: same op
//     UUID + identical payload → the original committed result; a reused UUID with
//     any changed semantic field (incl. the photo bytes) → 409.
// Only ADMINS close/resolve; drivers report + resubmit evidence.
const router = Router();

router.use((_req, _res, next) => {
  if (!exceptionsEnabled()) {
    next(new ApiError(404, "NOT_FOUND", "Not found."));
    return;
  }
  next();
});
router.use(requireAuth);

const orderByCreatedThenId = [{ created_at: "asc" as const }, { id: "asc" as const }];
const exceptionInclude = {
  actions: { orderBy: orderByCreatedThenId },
  evidence: { orderBy: orderByCreatedThenId },
};

const MAX_REASON = 2000;
const MAX_NOTE = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(name: string, v: string | undefined): string {
  if (!v || !UUID_RE.test(v)) throw new ApiError(400, "INVALID_OPERATION_ID", `${name} must be a valid UUID.`);
  return v;
}
function validateGeo(lat: number | null, lng: number | null, accuracy: number | null): void {
  if (lat !== null && (lat < -90 || lat > 90)) throw new ApiError(400, "INVALID_GEO", "Latitude out of range.");
  if (lng !== null && (lng < -180 || lng > 180)) throw new ApiError(400, "INVALID_GEO", "Longitude out of range.");
  if (accuracy !== null && (accuracy < 0 || accuracy > 100000)) throw new ApiError(400, "INVALID_GEO", "Accuracy out of range.");
}

async function loadException(tripId: string, exId: string) {
  const exc = await prisma.tripException.findFirst({ where: { id: exId, trip_id: tripId }, include: exceptionInclude });
  if (!exc) throw new ApiError(404, "EXCEPTION_NOT_FOUND", "Exception not found.");
  return exc;
}
async function reloadAndSend(res: import("express").Response, tripId: string, exId: string, audience: ExceptionAudience, status = 200) {
  const fresh = await loadException(tripId, exId);
  res.status(status).json({ exception: serializeException(fresh, audience) });
}

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

    if (!category || !(EXCEPTION_CATEGORIES as readonly string[]).includes(category)) throw new ApiError(400, "INVALID_CATEGORY", "A valid exception category is required.");
    if (!reason) throw new ApiError(400, "REASON_REQUIRED", "A reason is required.");
    if (reason.length > MAX_REASON) throw new ApiError(400, "REASON_TOO_LONG", `Reason exceeds ${MAX_REASON} characters.`);
    if (!req.file) throw new ApiError(400, "EVIDENCE_REQUIRED", "A photo is required (field name 'photo').");

    const lat = numField(req.body.lat);
    const lng = numField(req.body.lng);
    const accuracy = numField(req.body.accuracy_m);
    validateGeo(lat, lng, accuracy);
    const clientReportedAt = dateField(req.body.client_at);
    const capturedClientAt = dateField(req.body.captured_client_at);

    // SERVER-computed content identity (no client-supplied digest trusted).
    const photoSha256 = sha256Hex(req.file.buffer);
    const fingerprint = reportFingerprint({
      tripId, tripStopId, category, reason, reportedBy: driverId,
      clientActionId, clientEvidenceId, lat, lng, accuracyM: accuracy,
      clientReportedAt, capturedClientAt, photoSha256,
    });

    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { id: true, driver_id: true } });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    // AUTHORIZATION before any aggregate exposure (incl. replay).
    if (trip.driver_id !== driverId) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");

    if (tripStopId) {
      const stop = await prisma.tripStop.findFirst({ where: { id: tripStopId, trip_id: tripId }, select: { id: true } });
      if (!stop) throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
    }

    // Payload-sensitive idempotent replay (no re-upload).
    const existing = await prisma.tripException.findUnique({
      where: { trip_id_client_occurrence_id: { trip_id: tripId, client_occurrence_id: clientOccurrenceId } },
    });
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
      await reloadAndSend(res, tripId, existing.id, "full", 200);
      return;
    }

    const { url, publicId } = await uploadBuffer(req.file.buffer, EXCEPTION_EVIDENCE_FOLDER, { type: "authenticated" });

    let outcome: { id: string; created: boolean };
    try {
      outcome = await prisma.$transaction(async (tx) => {
        await lockTripRow(tx, tripId); // serialize with Arrived/Delivered
        // Re-read the AUTHORITATIVE state under the lock (never a preloaded value).
        const t2 = await tx.trip.findUnique({ where: { id: tripId }, select: { status: true, driver_id: true, open_exception_id: true } });
        if (!t2) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
        if (t2.driver_id !== driverId) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
        // Under the lock, re-check for THIS occurrence first: a concurrent winner
        // that committed the SAME occurrence is an idempotent replay (return it),
        // NOT an "already open" conflict. A DIFFERENT occurrence falls through to
        // the open-exception check below.
        const raced = await tx.tripException.findUnique({ where: { trip_id_client_occurrence_id: { trip_id: tripId, client_occurrence_id: clientOccurrenceId } } });
        if (raced) {
          if (raced.request_fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
          return { id: raced.id, created: false };
        }
        if (t2.status !== "in_progress") throw new ApiError(409, "TRIP_NOT_IN_PROGRESS", "An exception can only be reported while the trip is in progress.");
        if (t2.open_exception_id) throw new ApiError(409, "EXCEPTION_ALREADY_OPEN", "This trip already has an open exception.");

        const exc = await tx.tripException.create({
          data: {
            trip_id: tripId, trip_stop_id: tripStopId,
            client_occurrence_id: clientOccurrenceId, request_fingerprint: fingerprint,
            category: category as never, reason, reported_by: driverId,
            client_reported_at: clientReportedAt, current_state: "reported",
          },
        });
        const claim = await tx.trip.updateMany({ where: { id: tripId, status: "in_progress", open_exception_id: null }, data: { open_exception_id: exc.id } });
        if (claim.count !== 1) throw new ApiError(409, "EXCEPTION_ALREADY_OPEN", "This trip already has an open exception.");
        const action = await tx.exceptionAction.create({
          data: { exception_id: exc.id, client_action_id: clientActionId, type: "report", actor_id: driverId, actor_role: "driver", lat, lng, accuracy_m: accuracy, client_at: clientReportedAt },
        });
        await tx.exceptionEvidence.create({
          data: { exception_id: exc.id, action_id: action.id, client_evidence_id: clientEvidenceId, content_sha256: photoSha256, url, public_id: publicId, uploaded_by: driverId, captured_client_at: capturedClientAt },
        });
        await tx.auditLog.create({ data: { user_id: driverId, action: `exception.reported (${category})`, table_name: "TripException", record_id: exc.id } });
        await testHook("exceptionReport.beforeCommit");
        return { id: exc.id, created: true };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Concurrent unique-key race: same occurrence committed → compare + return;
        // otherwise a different exception is already open.
        const dupe = await prisma.tripException.findUnique({ where: { trip_id_client_occurrence_id: { trip_id: tripId, client_occurrence_id: clientOccurrenceId } } });
        if (dupe) {
          if (dupe.request_fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
          await reloadAndSend(res, tripId, dupe.id, "full", 200);
          return;
        }
        throw new ApiError(409, "EXCEPTION_ALREADY_OPEN", "This trip already has an open exception.");
      }
      throw err;
    }

    await reloadAndSend(res, tripId, outcome.id, "full", outcome.created ? 201 : 200);
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
    const capturedClientAt = dateField(req.body.captured_client_at);
    const photoSha256 = sha256Hex(req.file.buffer);

    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { driver_id: true } });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    if (trip.driver_id !== driverId) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");

    const exc = await loadException(tripId, exId);
    const incomingFp = evidenceFingerprint({ exceptionId: exId, kind: "photo", uploadedBy: driverId, capturedClientAt, photoSha256 });

    // Payload-sensitive idempotent replay (no re-upload).
    const prior = exc.evidence.find((e) => e.client_evidence_id === clientEvidenceId);
    if (prior) {
      const priorFp = evidenceFingerprint({ exceptionId: exId, kind: prior.kind, uploadedBy: prior.uploaded_by, capturedClientAt: prior.captured_client_at, photoSha256: prior.content_sha256 ?? "" });
      if (priorFp !== incomingFp) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This evidence id was already used with different content.");
      await reloadAndSend(res, tripId, exId, "full", 200);
      return;
    }
    const nextState = stateAfterEvidence(exc.current_state as never); // throws if closed

    const { url, publicId } = await uploadBuffer(req.file.buffer, EXCEPTION_EVIDENCE_FOLDER, { type: "authenticated" });
    const evidenceActionId = `ev:${clientEvidenceId}`; // server-derived, unique per exception

    let created: boolean;
    try {
      created = await prisma.$transaction(async (tx) => {
        const cas = await tx.tripException.updateMany({
          where: { id: exId, version: exc.version, closed_at: null },
          data: { current_state: nextState as never, version: { increment: 1 } },
        });
        if (cas.count !== 1) {
          // Re-read under the SAME op id: a same-evidence winner → idempotent OK;
          // a genuine change → conflict.
          const committed = await tx.exceptionEvidence.findFirst({ where: { exception_id: exId, client_evidence_id: clientEvidenceId } });
          if (committed) {
            const cFp = evidenceFingerprint({ exceptionId: exId, kind: committed.kind, uploadedBy: committed.uploaded_by, capturedClientAt: committed.captured_client_at, photoSha256: committed.content_sha256 ?? "" });
            if (cFp !== incomingFp) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This evidence id was already used with different content.");
            return false; // idempotent — winner already applied
          }
          throw new ApiError(409, "EXCEPTION_STATE_CHANGED", "This exception changed since you loaded it. Refresh and try again.");
        }
        const action = await tx.exceptionAction.create({ data: { exception_id: exId, client_action_id: evidenceActionId, type: "evidence_added", actor_id: driverId, actor_role: "driver" } });
        await tx.exceptionEvidence.create({ data: { exception_id: exId, action_id: action.id, client_evidence_id: clientEvidenceId, content_sha256: photoSha256, url, public_id: publicId, uploaded_by: driverId, captured_client_at: capturedClientAt } });
        await tx.auditLog.create({ data: { user_id: driverId, action: "exception.evidence_added", table_name: "TripException", record_id: exId } });
        return true;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const committed = await prisma.exceptionEvidence.findFirst({ where: { exception_id: exId, client_evidence_id: clientEvidenceId } });
        if (committed) {
          const cFp = evidenceFingerprint({ exceptionId: exId, kind: committed.kind, uploadedBy: committed.uploaded_by, capturedClientAt: committed.captured_client_at, photoSha256: committed.content_sha256 ?? "" });
          if (cFp !== incomingFp) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This evidence id was already used with different content.");
          await reloadAndSend(res, tripId, exId, "full", 200);
          return;
        }
      }
      throw err;
    }
    await reloadAndSend(res, tripId, exId, "full", created ? 201 : 200);
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

function sameActionSemantics(a: { type: string; resolution: string | null; actor_id: string; note: string | null }, opts: { action: string; resolveWith?: string; actorId: string; note?: string }): boolean {
  return a.type === opts.action && (a.resolution ?? null) === (opts.resolveWith ?? null) && a.actor_id === opts.actorId && (a.note ?? null) === (opts.note ?? null);
}

async function applyTransition(opts: {
  tripId: string;
  exId: string;
  actorId: string;
  action: Exclude<ExceptionActionTypeT, "report" | "evidence_added">;
  /** Who is acting. Drivers may only ever reach `resume` (see the self-resume
   *  route); every other transition is admin-only at the router. Recorded on
   *  the append-only action so the log distinguishes "the office decided" from
   *  "the driver unblocked himself". */
  actorRole?: "admin" | "driver";
  clientActionId: string;
  note?: string;
  resolveWith?: ExceptionResolutionT;
  expectedVersion?: number;
}): Promise<void> {
  const exc = await loadException(opts.tripId, opts.exId);

  // Sequential replay (op id already committed): same semantics → OK; different → 409.
  const prior = exc.actions.find((a) => a.client_action_id === opts.clientActionId);
  if (prior) {
    if (!sameActionSemantics(prior, opts)) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
    return;
  }

  assertVersion(exc.version, opts.expectedVersion);
  const t = nextExceptionState(exc.current_state as never, opts.action, opts.resolveWith);
  const allowed = allowedFromStates(opts.action);

  try {
    await prisma.$transaction(async (tx) => {
      const cas = await tx.tripException.updateMany({
        where: { id: opts.exId, version: exc.version, closed_at: null, current_state: { in: allowed as never } },
        data: { current_state: t.state as never, resolution: t.resolution ?? undefined, resolved_at: t.closes ? new Date() : undefined, closed_at: t.closes ? new Date() : undefined, version: { increment: 1 } },
      });
      if (cas.count !== 1) {
        // Concurrent same-op replay → return the winner's result; else genuine conflict.
        const committed = await tx.exceptionAction.findFirst({ where: { exception_id: opts.exId, client_action_id: opts.clientActionId } });
        if (committed) {
          if (!sameActionSemantics(committed, opts)) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
          return; // idempotent — winner already applied
        }
        throw new ApiError(409, "EXCEPTION_STATE_CHANGED", "This exception changed since you loaded it. Refresh and try again.");
      }
      await tx.exceptionAction.create({ data: { exception_id: opts.exId, client_action_id: opts.clientActionId, type: opts.action, resolution: t.resolution ?? null, actor_id: opts.actorId, actor_role: opts.actorRole ?? "admin", note: opts.note ?? null } });
      if (t.closes) {
        // Pointer clear MUST match exactly one row, else the projection and the
        // cache pointer would disagree — throw and roll the whole close back.
        const ptr = await tx.trip.updateMany({ where: { id: opts.tripId, open_exception_id: opts.exId }, data: { open_exception_id: null } });
        if (ptr.count !== 1) throw new ApiError(409, "POINTER_INCONSISTENT", "The trip's open-exception pointer was not in the expected state; the close was rolled back.");
      }
      await tx.auditLog.create({ data: { user_id: opts.actorId, action: `exception.${opts.action}${t.resolution ? ` (${t.resolution})` : ""}${opts.actorRole === "driver" ? " [driver self-resume]" : ""}${opts.note ? `: ${opts.note}` : ""}`, table_name: "TripException", record_id: opts.exId } });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const fresh = await loadException(opts.tripId, opts.exId);
      const committed = fresh.actions.find((a) => a.client_action_id === opts.clientActionId);
      if (committed) {
        if (!sameActionSemantics(committed, opts)) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
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

router.post("/:id/exception/:exId/resume", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    await applyTransition({ tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, action: "resume", clientActionId: client_action_id, note, resolveWith: "resume", expectedVersion: expected_version });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

// ── POST /:id/exception/:exId/self-resume — the DRIVER unblocks his own trip ──
//
// THE PROBLEM THIS SOLVES. An open exception freezes the trip: it blocks every
// delivery and the finalization (routes/trips.ts checks open_exception_id). So
// before this route, a driver who reported a problem could do NOTHING until an
// admin happened to be at a screen. On a fleet with one admin, a report filed at
// 8pm stranded a loaded truck and every remaining consignee on that run until
// morning. That is the hard blocker on turning FEATURE_EXCEPTIONS on.
//
// WHAT IT IS: "I have filed it, I am carrying on." It closes the exception so
// the truck moves. It is NOT a decision about the stop and NOT a decision about
// pay.
//
// WHY IT CANNOT MOVE MONEY. Pay needs BOTH an admin `verify` action and a
// `resume` closure (services/undeliveredPay). `verify` is admin-only at the
// router and a driver has no route that creates one, so a driver acting alone
// closes with resume-and-no-verify — which pays nothing and leaves the stop
// OUTSTANDING, still his to deliver. The only way this settles a stop is if an
// admin had ALREADY verified it, i.e. the office already made the pay decision
// and the driver merely stopped waiting on them. That is the intended outcome,
// not a loophole.
//
// The action is recorded with actor_role "driver", so the append-only log and
// the audit line distinguish it from an admin's resume forever.
router.post("/:id/exception/:exId/self-resume", requireRole("driver"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    // Ownership: his own trip only. Checked BEFORE any aggregate is exposed,
    // matching the report route — an exception id is not a capability.
    const trip = await prisma.trip.findUnique({ where: { id: req.params.id }, select: { driver_id: true } });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    if (trip.driver_id !== req.user!.id) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");

    await applyTransition({
      tripId: req.params.id,
      exId: req.params.exId,
      actorId: req.user!.id,
      actorRole: "driver",
      action: "resume",
      clientActionId: client_action_id,
      note,
      resolveWith: "resume",
      expectedVersion: expected_version,
    });
    // "full" audience: it is his own report, the same view he already has.
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

const resolveSchema = reviewSchema.extend({ resolution: z.string().min(1) });
router.post("/:id/exception/:exId/resolve", requireRole("admin"), validateBody(resolveSchema), async (req, res, next) => {
  try {
    const { resolution, note, client_action_id, expected_version } = req.body as { resolution: string; note?: string; client_action_id: string; expected_version?: number };
    await applyTransition({ tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, action: "resolve", clientActionId: client_action_id, note, resolveWith: resolution as ExceptionResolutionT, expectedVersion: expected_version });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

// ── GET /exceptions/open — admin list for the Exceptions lane (open only) ─────
// Read-only summary rows; the detail view fetches GET /:id/exception (full). The
// path (2 segments, 2nd = "open") cannot collide with /:id/exception.
router.get("/exceptions/open", requireRole("admin"), async (_req, res, next) => {
  try {
    const rows = await prisma.tripException.findMany({
      where: { closed_at: null },
      orderBy: { created_at: "asc" },
      include: {
        trip: { select: { id: true, ticket_number: true, truck_plate: true, driver: { select: { name: true } } } },
        trip_stop: { select: { sequence: true, consignee: { select: { company_name: true } } } },
      },
    });
    res.json({
      exceptions: rows.map((r) => ({
        id: r.id,
        trip_id: r.trip_id,
        ticket_number: r.trip.ticket_number,
        driver_name: r.trip.driver?.name ?? null,
        truck_plate: r.trip.truck_plate,
        category: r.category,
        current_state: r.current_state,
        reason: r.reason,
        reported_at: r.reported_at,
        stop: r.trip_stop ? { sequence: r.trip_stop.sequence, company_name: r.trip_stop.consignee.company_name } : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id/exception — current/latest exception (role-aware, requestor redacted)
router.get("/:id/exception", requireRole("driver", "admin", "requestor"), async (req, res, next) => {
  try {
    const tripId = req.params.id;
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { driver_id: true, requestor_id: true } });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");

    const role = req.user!.role;
    let audience: ExceptionAudience;
    if (role === "admin") audience = "full";
    else if (role === "driver" && trip.driver_id === req.user!.id) audience = "full";
    else if (role === "requestor" && trip.requestor_id === req.user!.id) audience = "redacted";
    else throw new ApiError(403, "FORBIDDEN", "You do not have access to this trip's exceptions.");

    const exc =
      (await prisma.tripException.findFirst({ where: { trip_id: tripId, closed_at: null }, include: exceptionInclude, orderBy: [{ created_at: "desc" }, { id: "desc" }] })) ??
      (await prisma.tripException.findFirst({ where: { trip_id: tripId }, include: exceptionInclude, orderBy: [{ created_at: "desc" }, { id: "desc" }] }));

    res.json({ exception: exc ? serializeException(exc, audience) : null });
  } catch (err) {
    next(err);
  }
});

export default router;
