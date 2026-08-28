import { Router } from "express";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { CLEARED_LOCKOUT_STATE, isLocked, isLockoutEnabled } from "../lib/loginLockout";
import { effectiveLockoutConfig } from "../lib/securitySettings";
import {
  claimablePasswordResetRequestWhere,
  effectivePasswordResetStatus,
} from "../lib/passwordResetRequests";

// The admin queue for self-service password reset requests (owner-approved
// design, 20 Aug 2026). Identity verification is the whole job here — see the
// fields this list surfaces — so every admin route in this file is read-heavy
// on the User row, not just the request itself.
const router = Router();
router.use(requireAuth, requireRole("admin"));

// ── GET /password-reset-requests — the actionable queue ─────────────────
// Defaults to pending (+ time-expired) requests, oldest first — the office's
// actual work queue. `?status=all` returns the full history for context.
router.get("/", async (req, res, next) => {
  try {
    const includeResolved = req.query.status === "all";
    const requests = await prisma.passwordResetRequest.findMany({
      where: includeResolved ? {} : { status: "pending" },
      orderBy: { requested_at: "asc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            employee_number: true,
            assigned_truck_plate: true,
            failed_login_attempts: true,
            locked_until: true,
            last_login_at: true,
          },
        },
        resolver: { select: { id: true, name: true } },
      },
    });
    const now = new Date();
    const lockout = await effectiveLockoutConfig();
    const lockoutOn = isLockoutEnabled(lockout);

    res.json(
      requests.map((r) => ({
        id: r.id,
        status: effectivePasswordResetStatus(r, now),
        requested_at: r.requested_at,
        resolved_at: r.resolved_at,
        resolved_by: r.resolver ? { id: r.resolver.id, name: r.resolver.name } : null,
        user: {
          id: r.user.id,
          name: r.user.name,
          phone: r.user.phone,
          employee_number: r.user.employee_number,
          assigned_truck_plate: r.user.assigned_truck_plate,
          is_locked: lockoutOn && isLocked(r.user, now),
          last_login_at: r.user.last_login_at,
        },
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ── PATCH /password-reset-requests/:id/approve ───────────────────────────
// Promotes the requester's OWN chosen password onto their account, clears the
// lockout (R6: "approving should also clear the lockout" — the driver picked
// a working password; there is nothing left to be locked out FOR), and
// revokes their current session, same as the admin-driven /forgot-password.
router.patch("/:id/approve", async (req, res, next) => {
  try {
    const { id } = req.params;
    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      // CAS: only a request that is still genuinely pending (not expired,
      // not already resolved by anything else — including a login that just
      // landed) can be claimed. The WHERE carries the expiry check so there
      // is no read-then-write gap to race.
      const claimed = await tx.passwordResetRequest.updateMany({
        where: { id, ...claimablePasswordResetRequestWhere(now) },
        data: { status: "approved", resolved_at: now, resolved_by: req.user!.id },
      });
      if (claimed.count !== 1) return null;

      const request = await tx.passwordResetRequest.findUniqueOrThrow({ where: { id } });
      await tx.user.update({
        where: { id: request.user_id },
        data: {
          password_hash: request.new_password_hash,
          refresh_token_hash: null,
          ...CLEARED_LOCKOUT_STATE,
        },
      });
      return request;
    });

    if (!updated) {
      throw new ApiError(
        409,
        "REQUEST_NOT_APPROVABLE",
        "This request is no longer pending — it may have expired or already been resolved."
      );
    }

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: "password_reset_request.approved",
        table_name: "PasswordResetRequest",
        record_id: id,
      },
    });

    res.json({ message: "Password reset approved." });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /password-reset-requests/:id/dismiss ───────────────────────────
// Closes a request without approving it — a wrong number, a resolved-by-
// phone-call case, or one the admin judges not genuine. No expiry gate: a
// time-expired request is still visibly "pending" in the DB and worth
// letting an admin explicitly close rather than leaving it to rot silently.
router.patch("/:id/dismiss", async (req, res, next) => {
  try {
    const { id } = req.params;
    const claimed = await prisma.passwordResetRequest.updateMany({
      where: { id, status: "pending" },
      data: { status: "dismissed", resolved_at: new Date(), resolved_by: req.user!.id },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "REQUEST_NOT_PENDING", "This request has already been resolved.");
    }

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: "password_reset_request.dismissed",
        table_name: "PasswordResetRequest",
        record_id: id,
      },
    });

    res.json({ message: "Dismissed." });
  } catch (err) {
    next(err);
  }
});

export default router;
