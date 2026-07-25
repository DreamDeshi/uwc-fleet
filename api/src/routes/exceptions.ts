import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
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
  nextExceptionState,
  stateAfterEvidence,
  type ExceptionActionTypeT,
} from "../services/exceptionWorkflow";

// ── Failed-delivery / exception workflow (Phase 1, feature-flagged) ───────────
// Mounted at /api/v1/trips (alongside the trips router). MONEY-FREE: this router
// never reads or writes an incentive/rate/finalization field, never changes
// Trip.status (it stays in_progress), and never releases capacity. See
// services/exceptionWorkflow.ts for the pure state machine + the frozen-boundary
// gate that limits execution to resume/retry.
const router = Router();

// Feature gate FIRST: while off, these routes 404 as if absent.
router.use((_req, _res, next) => {
  if (!exceptionsEnabled()) {
    next(new ApiError(404, "NOT_FOUND", "Not found."));
    return;
  }
  next();
});
router.use(requireAuth);

const exceptionInclude = {
  actions: { orderBy: { created_at: "asc" as const } },
  evidence: { orderBy: { created_at: "asc" as const } },
};

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

// A best-effort finite number from a multipart text field.
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
    const clientOccurrenceId = strField(req.body.client_occurrence_id);
    const clientActionId = strField(req.body.client_action_id);
    const clientEvidenceId = strField(req.body.client_evidence_id);
    const tripStopId = strField(req.body.trip_stop_id) ?? null;

    if (!category || !(EXCEPTION_CATEGORIES as readonly string[]).includes(category)) {
      throw new ApiError(400, "INVALID_CATEGORY", "A valid exception category is required.");
    }
    if (!reason) throw new ApiError(400, "REASON_REQUIRED", "A reason is required.");
    if (!clientOccurrenceId || !clientActionId || !clientEvidenceId) {
      throw new ApiError(400, "MISSING_OPERATION_ID", "client_occurrence_id, client_action_id and client_evidence_id are required.");
    }
    if (!req.file) {
      throw new ApiError(400, "EVIDENCE_REQUIRED", "A photo is required (field name 'photo').");
    }

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, status: true, driver_id: true },
    });
    if (!trip) throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");

    // Idempotent replay: this occurrence already landed — return it, don't
    // re-upload or duplicate.
    const existing = await prisma.tripException.findUnique({
      where: { trip_id_client_occurrence_id: { trip_id: tripId, client_occurrence_id: clientOccurrenceId } },
    });
    if (existing) {
      await reloadAndSend(res, tripId, existing.id, "full", 200);
      return;
    }

    // Cheap up-front guards (pure) before the upload, so an ineligible report
    // never orphans a Cloudinary asset. The one-open race is still closed
    // atomically by the CAS below.
    assertCanReport(trip, driverId);

    if (tripStopId) {
      const stop = await prisma.tripStop.findFirst({ where: { id: tripStopId, trip_id: tripId } });
      if (!stop) throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
    }

    const { url, publicId } = await uploadBuffer(req.file.buffer, EXCEPTION_EVIDENCE_FOLDER, {
      type: "authenticated",
    });

    let excId: string;
    try {
      excId = await prisma.$transaction(async (tx) => {
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
        // Atomic one-open-per-trip guard: claim the pointer only while the trip
        // is in_progress AND has no open exception. A loser rolls the whole tx
        // back (no orphan row) with a 409.
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
            lat: numField(req.body.lat),
            lng: numField(req.body.lng),
            accuracy_m: numField(req.body.accuracy_m),
            client_at: dateField(req.body.client_at),
          },
        });
        await tx.exceptionEvidence.create({
          data: {
            exception_id: exc.id,
            action_id: action.id,
            client_evidence_id: clientEvidenceId,
            url,
            public_id: publicId,
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
      // Lost the idempotency race (same occurrence id committed concurrently).
      if (isUniqueViolation(err)) {
        const dupe = await prisma.tripException.findUnique({
          where: { trip_id_client_occurrence_id: { trip_id: tripId, client_occurrence_id: clientOccurrenceId } },
        });
        if (dupe) {
          await reloadAndSend(res, tripId, dupe.id, "full", 200);
          return;
        }
      }
      throw err;
    }

    await reloadAndSend(res, tripId, excId, "full", 201);
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/exception/:exId/evidence — driver adds evidence (resubmission)
router.post("/:id/exception/:exId/evidence", requireRole("driver"), upload.single("photo"), async (req, res, next) => {
  try {
    const { id: tripId, exId } = req.params;
    const driverId = req.user!.id;
    const clientEvidenceId = strField(req.body.client_evidence_id);
    if (!clientEvidenceId) throw new ApiError(400, "MISSING_OPERATION_ID", "client_evidence_id is required.");
    if (!req.file) throw new ApiError(400, "EVIDENCE_REQUIRED", "A photo is required (field name 'photo').");

    const exc = await loadException(tripId, exId);
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { driver_id: true } });
    if (trip?.driver_id !== driverId) {
      throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
    }
    // Idempotent replay.
    if (exc.evidence.some((e) => e.client_evidence_id === clientEvidenceId)) {
      await reloadAndSend(res, tripId, exId, "full", 200);
      return;
    }
    // Throws EXCEPTION_CLOSED if not open; computes the derived state after add.
    const nextState = stateAfterEvidence(exc.current_state as never);

    const { url, publicId } = await uploadBuffer(req.file.buffer, EXCEPTION_EVIDENCE_FOLDER, {
      type: "authenticated",
    });

    try {
      await prisma.$transaction(async (tx) => {
        await tx.exceptionEvidence.create({
          data: {
            exception_id: exId,
            client_evidence_id: clientEvidenceId,
            url,
            public_id: publicId,
            uploaded_by: driverId,
            captured_client_at: dateField(req.body.captured_client_at),
          },
        });
        await tx.tripException.update({
          where: { id: exId },
          data: { current_state: nextState as never, version: { increment: 1 } },
        });
        await tx.auditLog.create({
          data: { user_id: driverId, action: "exception.evidence_added", table_name: "TripException", record_id: exId },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
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

// ── Admin review transitions (request-more-evidence / verify / reject) ────────
const reviewSchema = z.object({
  client_action_id: z.string().min(1),
  note: z.string().optional(),
  expected_version: z.number().int().optional(),
});

/** Shared admin/driver transition executor for the non-multipart actions. */
async function applyTransition(opts: {
  tripId: string;
  exId: string;
  actorId: string;
  actorRole: "admin" | "driver";
  action: Exclude<ExceptionActionTypeT, "report">;
  clientActionId: string;
  note?: string;
  resolveWith?: "retry" | "resume";
  expectedVersion?: number;
}): Promise<void> {
  const exc = await loadException(opts.tripId, opts.exId);
  // Idempotent replay: this exact action already recorded → no-op success.
  if (exc.actions.some((a) => a.client_action_id === opts.clientActionId)) return;
  assertVersion(exc.version, opts.expectedVersion);

  const t = nextExceptionState(exc.current_state as never, opts.action, opts.resolveWith);

  await prisma.$transaction(async (tx) => {
    await tx.exceptionAction.create({
      data: {
        exception_id: opts.exId,
        client_action_id: opts.clientActionId,
        type: opts.action,
        resolution: t.resolution ?? null,
        actor_id: opts.actorId,
        actor_role: opts.actorRole,
        note: opts.note ?? null,
      },
    });
    await tx.tripException.update({
      where: { id: opts.exId },
      data: {
        current_state: t.state as never,
        resolution: t.resolution ?? undefined,
        resolved_at: t.closes ? new Date() : undefined,
        closed_at: t.closes ? new Date() : undefined,
        version: { increment: 1 },
      },
    });
    // Closing an exception releases the trip's one-open pointer. Trip.status is
    // deliberately UNCHANGED (stays in_progress) — no capacity/pay effect.
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
}

router.post("/:id/exception/:exId/request-more-evidence", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    if (!note || note.trim() === "") throw new ApiError(400, "NOTE_REQUIRED", "A note is required when requesting more evidence.");
    await applyTransition({
      tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, actorRole: "admin",
      action: "request_more_evidence", clientActionId: client_action_id, note, expectedVersion: expected_version,
    });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

router.post("/:id/exception/:exId/verify", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    await applyTransition({
      tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, actorRole: "admin",
      action: "verify", clientActionId: client_action_id, note, expectedVersion: expected_version,
    });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

router.post("/:id/exception/:exId/reject", requireRole("admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    if (!note || note.trim() === "") throw new ApiError(400, "NOTE_REQUIRED", "A note is required when rejecting.");
    await applyTransition({
      tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, actorRole: "admin",
      action: "reject", clientActionId: client_action_id, note, expectedVersion: expected_version,
    });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

// ── Resume (driver or admin: CAN CONTINUE = yes) ─────────────────────────────
router.post("/:id/exception/:exId/resume", requireRole("driver", "admin"), validateBody(reviewSchema), async (req, res, next) => {
  try {
    const { note, client_action_id, expected_version } = req.body as { note?: string; client_action_id: string; expected_version?: number };
    if (req.user!.role === "driver") {
      const trip = await prisma.trip.findUnique({ where: { id: req.params.id }, select: { driver_id: true } });
      if (trip?.driver_id !== req.user!.id) throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
    }
    await applyTransition({
      tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, actorRole: req.user!.role as "admin" | "driver",
      action: "resume", clientActionId: client_action_id, note, resolveWith: "resume", expectedVersion: expected_version,
    });
    await reloadAndSend(res, req.params.id, req.params.exId, "full");
  } catch (err) { next(err); }
});

// ── Resolve (admin decision). Phase 1 EXECUTES only `retry`. ─────────────────
const resolveSchema = reviewSchema.extend({ resolution: z.string().min(1) });
router.post("/:id/exception/:exId/resolve", requireRole("admin"), validateBody(resolveSchema), async (req, res, next) => {
  try {
    const { resolution, note, client_action_id, expected_version } = req.body as { resolution: string; note?: string; client_action_id: string; expected_version?: number };
    // assertResolutionExecutable (inside nextExceptionState) refuses anything but
    // retry — reschedule/reassign/return/cancel cross a frozen boundary.
    await applyTransition({
      tripId: req.params.id, exId: req.params.exId, actorId: req.user!.id, actorRole: "admin",
      action: "resolve", clientActionId: client_action_id, note, resolveWith: resolution as "retry", expectedVersion: expected_version,
    });
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

    // Prefer the OPEN one; otherwise the most recent.
    const exc =
      (await prisma.tripException.findFirst({
        where: { trip_id: tripId, closed_at: null },
        include: exceptionInclude,
        orderBy: { created_at: "desc" },
      })) ??
      (await prisma.tripException.findFirst({
        where: { trip_id: tripId },
        include: exceptionInclude,
        orderBy: { created_at: "desc" },
      }));

    res.json({ exception: exc ? serializeException(exc, audience) : null });
  } catch (err) {
    next(err);
  }
});

export default router;
