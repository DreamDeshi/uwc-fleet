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
import { alertExceptionReported } from "../services/exceptionAlerts";
import { lockTripRow } from "../lib/tripLock";
import { testHook } from "../lib/testHooks";
import { sha256Hex, reportFingerprint, evidenceFingerprint } from "../lib/exceptionFingerprint";
import {
  EXCEPTION_EVIDENCE_FOLDER,
  serializeException,
  type ExceptionAudience,
} from "../lib/exceptionEvidence";
import type { Prisma } from "@prisma/client";
import { sendPushNotifications } from "../lib/pushNotifications";
import { SETTLED_UNDELIVERED_WHERE } from "../services/undeliveredPay";
import { proposeDeliveredStopsIncentive } from "../services/tripFinalize";
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
/**
 * Attach the DERIVED `blocking` flag — but only for audiences entitled to it.
 *
 * `blocking` answers "is this report currently stopping the driver", which is
 * an OPERATIONAL fact about the run, not part of the requestor's redacted view
 * (lib/exceptionEvidence documents that contract as category + coarse status +
 * timestamps ONLY). Spreading it on after the audience switch would put a
 * second, competing decision about requestor visibility outside the one
 * function that owns it — so it goes through here instead.
 */
function withBlocking<T extends object>(view: T, audience: ExceptionAudience, blocking: boolean): T {
  return audience === "redacted" ? view : ({ ...view, blocking } as T);
}

async function reloadAndSend(res: import("express").Response, tripId: string, exId: string, audience: ExceptionAudience, status = 200) {
  const fresh = await loadException(tripId, exId);
  // `blocking` is DERIVED from the trip pointer, never stored: an exception can
  // now be OPEN but not blocking, because the driver continued past it (see the
  // /continue route). The driver's card needs to tell "the office still has it"
  // from "and I am stuck here", and those became two different things.
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { open_exception_id: true } });
  res.status(status).json({
    exception: withBlocking(serializeException(fresh, audience), audience, trip?.open_exception_id === exId),
  });
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

    // AT-REPORT alert (best-effort, AFTER the commit, never awaited into the
    // response): the trip is paused from this instant, so an admin should hear
    // about it now rather than when the 30-minute sweep next runs. The sweep
    // stays as the escalation for reports nobody actions. Only on a genuinely
    // NEW report — an idempotent replay must not re-ping.
    if (outcome.created) void alertExceptionReported(outcome.id);

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

/**
 * Finalize the trip when CLOSING this exception left nothing outstanding.
 *
 * WHY THIS EXISTS. Since R3 Q11(a) a stop can be settled as paid-undelivered
 * (verify + resume) instead of delivered. On a single-drop trip — the canonical
 * Q11(a) case, "customer was closed" — that settles the LAST stop, and there is
 * then no further delivery event to trigger finalization. Without this the trip
 * would sit `in_progress` forever: the pay it just earned would never propose,
 * the driver would be locked out of every other trip by the one-active guard,
 * and the truck's capacity would never free. The 3am sweep deliberately never
 * touches in_progress, so nothing else would rescue it. Pay would exist only if
 * an admin thought to hit Abort — which files it as a `cancelled` timeline event
 * on a trip that is being paid.
 *
 * Mirrors the delivered branch exactly: same outstanding-stop predicate, same
 * shared scorer, same write-once CAS. Caller holds lockTripRow.
 * Returns true when this call finalized the trip (→ notify), false otherwise.
 */
async function finalizeIfNothingOutstanding(
  tx: Prisma.TransactionClient,
  tripId: string,
  actorId: string
): Promise<boolean> {
  const trip = await tx.trip.findUnique({ where: { id: tripId }, include: { truck: true } });
  // Only an OUT trip finalizes. An abort may have cancelled it while the
  // exception was open, and a trip with no driver has no ledger owner.
  if (!trip || trip.status !== "in_progress" || !trip.driver_id) return false;

  const remainingStops = await tx.tripStop.count({
    where: { trip_id: tripId, status: { not: "delivered" }, NOT: SETTLED_UNDELIVERED_WHERE },
  });
  if (remainingStops > 0) return false;

  // Nothing left to deliver. If NOTHING earned either (e.g. the exception was
  // rejected, or resumed without a verify), there is no incentive to propose —
  // leave the trip alone for the admin to abort, which is the existing unpaid
  // path. Only a trip with at least one earning stop finalizes here.
  const earning = await tx.tripStop.count({
    where: { trip_id: tripId, OR: [{ status: "delivered" }, SETTLED_UNDELIVERED_WHERE] },
  });
  if (earning === 0) return false;

  const proposed = await proposeDeliveredStopsIncentive(tx, trip, trip.driver_id);
  if (proposed === null) return false; // CAS lost — someone else finalized it
  await tx.auditLog.create({
    data: {
      user_id: actorId,
      action: `trip.settled_pending_approval — no stops outstanding after the exception closed (RM${proposed} proposed)`,
      table_name: "Trip",
      record_id: tripId,
    },
  });
  return true;
}

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

  // Sequential replay (op id already committed): same semantics → OK; different → 409.
  const prior = exc.actions.find((a) => a.client_action_id === opts.clientActionId);
  if (prior) {
    if (!sameActionSemantics(prior, opts)) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation id was already used with different details.");
    return;
  }

  assertVersion(exc.version, opts.expectedVersion);
  const t = nextExceptionState(exc.current_state as never, opts.action, opts.resolveWith);
  const allowed = allowedFromStates(opts.action);
  let finalized = false;

  try {
    await prisma.$transaction(async (tx) => {
      // Lock the trip FIRST (lib/tripLock discipline) — a CLOSING transition can
      // now finalize the trip (see below), so it must serialize against the
      // delivered/abort paths exactly as they serialize against each other.
      // Taken unconditionally rather than only when `t.closes`: the lock order
      // must not depend on the action, or two transitions could deadlock.
      await lockTripRow(tx, opts.tripId);
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
      await tx.exceptionAction.create({ data: { exception_id: opts.exId, client_action_id: opts.clientActionId, type: opts.action, resolution: t.resolution ?? null, actor_id: opts.actorId, actor_role: "admin", note: opts.note ?? null } });
      if (t.closes) {
        // Clear the trip's block if this exception is the one holding it.
        //
        // count === 0 is now LEGITIMATE: the driver may have continued past
        // this report (POST /continue), which clears the pointer while leaving
        // the exception open. So the invariant is no longer "exactly one row
        // updated" — it is "the trip is not left pointing at an exception we
        // just closed". Re-read and assert that instead; anything else is a
        // genuine inconsistency and still rolls the whole close back.
        const ptr = await tx.trip.updateMany({ where: { id: opts.tripId, open_exception_id: opts.exId }, data: { open_exception_id: null } });
        if (ptr.count !== 1) {
          // The ONLY legitimate reason to match 0 rows is that the driver
          // continued past this report, which leaves the pointer NULL. Any
          // other value means the trip is pointing at some third exception
          // while we close this one — an inconsistency that would leave the
          // trip permanently blocked (delivery, abort and finalization all
          // refuse, and no route can clear a pointer to a closed exception).
          // The DB's one-open-per-trip index makes that unreachable in theory;
          // this is the assertion that says so out loud.
          const t2 = await tx.trip.findUnique({ where: { id: opts.tripId }, select: { open_exception_id: true } });
          if (!t2 || t2.open_exception_id !== null) {
            throw new ApiError(409, "POINTER_INCONSISTENT", "The trip's open-exception pointer was not in the expected state; the close was rolled back.");
          }
        }
      }
      await tx.auditLog.create({ data: { user_id: opts.actorId, action: `exception.${opts.action}${t.resolution ? ` (${t.resolution})` : ""}${opts.note ? `: ${opts.note}` : ""}`, table_name: "TripException", record_id: opts.exId } });
      if (t.closes) finalized = await finalizeIfNothingOutstanding(tx, opts.tripId, opts.actorId);
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

  // Best-effort, OUTSIDE the tx — same notification the delivered branch sends,
  // so a trip that finalized this way reaches the approval queue by the same
  // route as any other. Without it the pay is proposed silently and waits for
  // an admin to happen to look.
  if (finalized) await notifyPendingApproval(opts.tripId);
}

/** "Trip awaiting approval" push to every admin with a device. Never throws. */
async function notifyPendingApproval(tripId: string): Promise<void> {
  try {
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { ticket_number: true } });
    const admins = await prisma.user.findMany({
      where: { role: "admin", status: "active", expo_push_token: { not: null } },
      select: { expo_push_token: true },
    });
    await sendPushNotifications(admins.map((a) => a.expo_push_token), {
      title: "Trip awaiting approval",
      body: `Trip ${trip?.ticket_number ?? ""} closed with no stops outstanding — approve to release the incentive`,
      data: { type: "pending_approval", tripId },
    });
  } catch {
    // A failed push must never roll back or fail an already-committed close.
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

// ── POST /:id/exception/:exId/continue — the DRIVER unblocks his own trip ────
//
// THE PROBLEM. An open exception sets Trip.open_exception_id, which blocks
// every delivery and the finalization on that trip. So a driver who reported a
// problem could do nothing until an admin was at a screen: a report filed at
// 8pm stranded a loaded truck and every remaining consignee until morning.
//
// THE RULE THIS IMPLEMENTS (owner ruling, 29 Jul 2026 — a design call, not a
// question for the client, because it follows from rules he has already given):
//
//     the driver's "Continue trip" carries on and SETTLES NOTHING;
//     an admin marking a stop undeliverable is the ONLY thing that pays.
//
// So this route deliberately writes NO resolution and NO ExceptionAction. It
// clears the trip's BLOCK and leaves the exception exactly as it was — open,
// unadjudicated, and still the office's to decide.
//
// WHY NOT CLOSE IT (the earlier design, withdrawn). Closing it with
// `resolution: "resume"` let the driver supply the half that PAYS: pay is
// `resolved` + `resume` + a `verify` action (services/undeliveredPay), so a
// driver tapping continue after an admin had verified — but while the admin
// intended Retry or Reject — moved RM77 by winning a race against the admin's
// own CAS. Closing it any OTHER way was equally wrong in the opposite
// direction: a closed exception is terminal (nextExceptionState throws
// EXCEPTION_CLOSED), so no admin could ever verify it afterwards and the driver
// silently forfeited his own R3-Q11(a) entitlement.
//
// Leaving it open is the only shape where the driver decides nothing at all.
//
// CONSEQUENCE, deliberate: `open_exception_id` now means "an exception is
// BLOCKING this trip", not "an exception is open". Reads that want "is anything
// open" query TripException.closed_at, which the admin lane already does.
//
// ✅ RESOLVED (migration 20260730120000_relax_one_open_exception_per_trip): a
// driver who has continued past one report CAN now file a second. The old
// partial unique index `TripException_one_open_per_trip` (one row per trip with
// closed_at IS NULL) meant carrying on past a customer-site problem and then
// breaking down left him phoning the office; it encoded one-OPEN-per-trip when
// the rule was only ever one-BLOCKING-per-trip.
//
// What still holds the line: `Trip.open_exception_id` is a SINGLE nullable
// column (and itself unique), so a trip cannot be blocked by two exceptions at
// once — the guard above and the CAS below are the enforcement, not the index.
// Reporting is still refused while the pointer is set; the driver must continue
// past, or the office must close, the current one first.
router.post("/:id/exception/:exId/continue", requireRole("driver"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { id: tripId, exId } = req.params;
    const driverId = req.user!.id;

    // Ownership BEFORE any aggregate exposure — an exception id is not a
    // capability (same ordering as the report route).
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { driver_id: true, status: true } });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    if (trip.driver_id !== driverId) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
    if (trip.status !== "in_progress") {
      throw new ApiError(409, "TRIP_NOT_IN_PROGRESS", "This trip is not in progress.");
    }

    const exc = await loadException(tripId, exId);
    if (exc.closed_at) {
      throw new ApiError(409, "EXCEPTION_CLOSED", "This report is already closed — the trip is not blocked by it.");
    }

    await prisma.$transaction(async (tx) => {
      await lockTripRow(tx, tripId); // serialize with Arrived/Delivered/report
      // CAS on the pointer: only the exception that is ACTUALLY blocking may be
      // continued past, and only once. A concurrent admin close (which clears
      // the same pointer) makes this a no-op rather than a conflict — either
      // way the driver ends up unblocked, which is all he asked for.
      const cleared = await tx.trip.updateMany({
        where: { id: tripId, status: "in_progress", open_exception_id: exId },
        data: { open_exception_id: null },
      });
      if (cleared.count === 1) {
        await tx.auditLog.create({
          data: {
            user_id: driverId,
            // No ExceptionActionType fits "continued without deciding", and the
            // enum is frozen — the audit row is the record. It is deliberately
            // NOT an ExceptionAction: the action log is the adjudication trail,
            // and this is not an adjudication.
            action: "exception.driver_continued (trip unblocked; report left open for the office)",
            table_name: "TripException",
            record_id: exId,
          },
        });
      }
    });

    await reloadAndSend(res, tripId, exId, "full");
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
        // arrived_at: the admin UI needs it to know whether a verify can PAY this
        // stop at all — Q11(b), a stop the driver never reached earns nothing.
        trip_stop: { select: { sequence: true, arrived_at: true, consignee: { select: { company_name: true } } } },
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
        stop: r.trip_stop ? { sequence: r.trip_stop.sequence, arrived_at: r.trip_stop.arrived_at, company_name: r.trip_stop.consignee.company_name } : null,
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
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { driver_id: true, requestor_id: true, open_exception_id: true } });
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

    // `blocking` derived, as in reloadAndSend: OPEN and BLOCKING are no longer
    // the same thing once a driver has continued past a report.
    res.json({
      exception: exc
        ? withBlocking(serializeException(exc, audience), audience, trip.open_exception_id === exc.id)
        : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
