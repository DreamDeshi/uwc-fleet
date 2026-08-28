import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { isNormalizedPhone, normalizePhone } from "../lib/phone";
import { validateBody } from "../middleware/validate";
import { accountStatusError, requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { sensitiveRateLimiter } from "../middleware/rateLimit";
import { isStrongPassword, passwordProblemMessage } from "../lib/passwordPolicy";
import { BCRYPT_COST, burnPasswordCompare } from "../lib/loginTiming";
import {
  CLEARED_LOCKOUT_STATE,
  afterFailedAttempt,
  isLocked,
  isLockoutEnabled,
  lockRemainingMs,
  lockoutMessage,
  needsClearing,
} from "../lib/loginLockout";
import { effectiveLockoutConfig } from "../lib/securitySettings";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt";

const router = Router();


// ── POST /auth/register ──────────────────────────────────────────────

const registerSchema = z.object({
  phone: z.string().min(8, "Phone number is too short"),
  // ⚠ THE SAME FLOOR EVERYWHERE (lib/passwordPolicy). Registration accepted six
  // characters until 3 Aug 2026, which made it the last way to sit below the
  // strength the prod accounts were rotated to.
  password: z
    .string()
    .refine(isStrongPassword, (p) => ({ message: passwordProblemMessage(p) })),
  name: z.string().min(1, "Name is required"),
  // Spec REQUESTOR INTERFACE: every user must supply department + employee
  // number before they can register.
  employee_number: z.string().min(1, "Employee number is required"),
  department_id: z.string().min(1, "Department is required"),
  role: z.enum(["driver", "requestor"]),
});

router.post("/register", validateBody(registerSchema), async (req, res, next) => {
  try {
    const { password, name, employee_number, department_id, role } = req.body;

    const phone = normalizePhone(req.body.phone);
    if (!isNormalizedPhone(phone)) {
      throw new ApiError(400, "INVALID_PHONE", "Enter a valid Malaysian phone number.");
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new ApiError(409, "PHONE_ALREADY_REGISTERED", "An account with this phone number already exists.");
    }

    const department = await prisma.department.findUnique({ where: { id: department_id } });
    if (!department) {
      throw new ApiError(400, "DEPARTMENT_NOT_FOUND", "Selected department does not exist.");
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_COST);

    const user = await prisma.user.create({
      data: {
        phone,
        password_hash,
        name,
        employee_number,
        department_id,
        role,
        status: "pending_approval",
      },
    });

    res.status(201).json({
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      status: user.status,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────

const loginSchema = z.object({
  phone: z.string().min(1, "Phone is required"),
  password: z.string().min(1, "Password is required"),
});

// Login carries the strict per-IP limiter (10/min, same as password change/reset):
// the global 100/min budget is shared with all traffic and far too loose to slow
// credential stuffing against known phones. `SENSITIVE_RATE_LIMIT_MAX=0` disables
// it (the test/e2e suites drive one API from one IP); prod sets nothing → 10/min.
//
// It ALSO carries the SC3 per-account lockout (lib/loginLockout), which covers
// what the per-IP limiter cannot: a patient attacker on one known phone, slow
// enough never to trip a per-minute cap. `LOGIN_LOCKOUT_MAX_ATTEMPTS=0` disables
// that half, and the disabled path touches neither column.
router.post("/login", sensitiveRateLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { password } = req.body;

    const phone = normalizePhone(req.body.phone);
    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      // ⚠ PAY THE BCRYPT COST ANYWAY. Returning here without hashing made an
      // unknown phone answer ~100ms faster than a real one, which turned one
      // request into a phone-number oracle while the response body said nothing.
      // See lib/loginTiming for what this closes and what it deliberately does
      // not. Do NOT "optimise" this call away.
      await burnPasswordCompare(password);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Phone number or password is incorrect.");
    }

    const lockout = await effectiveLockoutConfig();
    const lockoutOn = isLockoutEnabled(lockout);
    const now = new Date();

    // ⚠ CHECKED BEFORE THE PASSWORD COMPARE, on purpose. A locked account is
    // refused even when the guess is CORRECT — a lockout that yielded to the
    // right password would stop nothing, since the right password is exactly
    // what the attacker is hunting for. It also means a locked account costs an
    // attacker a bcrypt compare of our choosing (none) rather than one of theirs.
    if (lockoutOn && isLocked(user, now)) {
      throw new ApiError(423, "ACCOUNT_LOCKED", lockoutMessage(lockRemainingMs(user, now)));
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      if (lockoutOn) {
        const nextState = afterFailedAttempt(user, now, lockout);
        await prisma.user.update({ where: { id: user.id }, data: nextState });
        if (nextState.locked_until) {
          // The one lockout event worth a row: an admin looking for "is someone
          // grinding an account?" has nothing else to read. Individual failures
          // are deliberately NOT logged — at 10 per lock they would bury the
          // signal in the noise, and an attacker could inflate the table freely.
          // `user_id` is the SUBJECT here; a lockout has no human actor.
          await prisma.auditLog.create({
            data: {
              user_id: user.id,
              action: "user.login_locked",
              table_name: "User",
              record_id: user.id,
            },
          });
          throw new ApiError(
            423,
            "ACCOUNT_LOCKED",
            lockoutMessage(lockRemainingMs(nextState, now))
          );
        }
      }
      throw new ApiError(401, "INVALID_CREDENTIALS", "Phone number or password is incorrect.");
    }

    // The right password proves this is not the attack the counter is for, so it
    // clears — including for an account that is pending or disabled, which is
    // why this sits ABOVE the status checks rather than beside the token issue.
    // Conditional so the ordinary login keeps doing exactly one write.
    if (lockoutOn && needsClearing(user)) {
      await prisma.user.update({ where: { id: user.id }, data: CLEARED_LOCKOUT_STATE });
    }

    if (user.status === "pending_approval") {
      throw new ApiError(
        403,
        "ACCOUNT_PENDING_APPROVAL",
        "Your account is still waiting for admin approval. Ask the office to approve it."
      );
    }
    if (user.status === "disabled") {
      throw new ApiError(
        403,
        "ACCOUNT_DISABLED",
        "This account has been disabled. Contact the office if this is a mistake."
      );
    }

    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id });
    const refresh_token_hash = await bcrypt.hash(refreshToken, BCRYPT_COST);

    await prisma.user.update({
      where: { id: user.id },
      data: { refresh_token_hash, last_login_at: now },
    });
    // Password-reset request auto-close: a successful login is the "no longer
    // needed" event (R6, 20 Aug 2026) — the user got in with a password that
    // works, so any pending reset request is moot. CAS on status=pending; the
    // approve/dismiss routes use the identical pattern, so whichever settles
    // first simply wins the race. resolved_by stays null: this is the system
    // closing it, not an admin decision.
    // Password-reset request auto-close: a successful login is the "no longer
    // needed" event (R6, 20 Aug 2026) — the user got in with a password that
    // works, so any pending reset request is moot. CAS on status=pending; the
    // approve/dismiss routes use the identical pattern, so whichever settles
    // first simply wins the race. resolved_by stays null: this is the system
    // closing it, not an admin decision.
    await prisma.passwordResetRequest.updateMany({
      where: { user_id: user.id, status: "pending" },
      data: { status: "dismissed", resolved_at: now, resolved_by: null },
    });

    res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/refresh ─────────────────────────────────────────────────

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required"),
});

router.post("/refresh", validateBody(refreshSchema), async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.");
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.refresh_token_hash) {
      throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.");
    }

    const matches = await bcrypt.compare(refreshToken, user.refresh_token_hash);
    if (!matches) {
      throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.");
    }

    // A disabled/pending account must not be able to mint new tokens — without
    // this, a user disabled mid-session could refresh indefinitely.
    const statusErr = accountStatusError(user.status);
    if (statusErr) {
      throw statusErr;
    }

    // Rotation: issue a brand new pair, invalidate the old refresh token.
    const newAccessToken = signAccessToken({ sub: user.id, role: user.role });
    const newRefreshToken = signRefreshToken({ sub: user.id });
    const refresh_token_hash = await bcrypt.hash(newRefreshToken, BCRYPT_COST);

    await prisma.user.update({ where: { id: user.id }, data: { refresh_token_hash } });

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/forgot-password ────────────────────────────────────────
// No SMTP available — an admin resets the password directly.

// ⚠ THE SAME FLOOR THE PROD ROTATION USED (lib/passwordPolicy). This accepted
// six characters until 2 Aug 2026, which meant an admin reset could quietly
// undo the rotation of the seeded accounts one at a time — set a driver back to
// `abc123` and nothing complained. The rule lives in ONE module so the CLI and
// this route cannot drift apart.
const forgotPasswordSchema = z.object({
  user_id: z.string().min(1),
  new_password: z
    .string()
    .refine(isStrongPassword, (p) => ({ message: passwordProblemMessage(p) })),
});

router.post(
  "/forgot-password",
  sensitiveRateLimiter,
  requireAuth,
  requireRole("admin"),
  validateBody(forgotPasswordSchema),
  async (req, res, next) => {
    try {
      const { user_id, new_password } = req.body;

      const user = await prisma.user.findUnique({ where: { id: user_id } });
      if (!user) {
        throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
      }

      const password_hash = await bcrypt.hash(new_password, BCRYPT_COST);
      // Revoke the target's sessions (unlike a self-change): the point of an
      // admin reset is to lock out whoever currently holds the account.
      await prisma.user.update({
        where: { id: user_id },
        data: { password_hash, refresh_token_hash: null },
      });

      await prisma.auditLog.create({
        data: {
          user_id: req.user!.id, // the admin who performed the reset
          action: "user.password_reset_by_admin",
          table_name: "User",
          record_id: user_id,
        },
      });

      res.json({ message: "Password reset successfully." });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /auth/password-reset-requests — self-service, unauthenticated ──
//
// Owner-approved design, 20 Aug 2026: "the request survives nobody answering
// the phone." A driver who forgot their password cannot authenticate to ask
// for one, so this route takes no auth. It picks its OWN new password right
// here — nothing is ever transmitted — and an admin verifies identity before
// promoting it.
//
// ⚠ NON-ENUMERATION ON THREE SURFACES, on purpose:
//   - SAME STATUS (always 200, never a 404 for an unknown phone);
//   - SAME BODY (identical message regardless of what happened server-side);
//   - SAME TIMING (an unknown phone, and a known phone with an existing open
//     request, both still pay the same bcrypt cost as the branch that
//     actually creates a row — see burnPasswordCompare; hash and compare are
//     the same core work at a given cost factor, so this is the same fix
//     PR #185 applied to /login, reused here for the same class of oracle).
// A second dimension of rate limiting (one open request per user) is
// enforced by silently not creating a duplicate — never by a different
// response, which would itself be an enumeration channel.
const createPasswordResetRequestSchema = z.object({
  phone: z.string().min(1, "Phone is required"),
  new_password: z
    .string()
    .refine(isStrongPassword, (p) => ({ message: passwordProblemMessage(p) })),
});

router.post(
  "/password-reset-requests",
  sensitiveRateLimiter,
  validateBody(createPasswordResetRequestSchema),
  async (req, res, next) => {
    try {
      const { new_password } = req.body;
      const phone = normalizePhone(req.body.phone);
      const user = await prisma.user.findUnique({ where: { phone } });

      if (user) {
        const openRequest = await prisma.passwordResetRequest.findFirst({
          where: { user_id: user.id, status: "pending" },
        });
        if (!openRequest) {
          const new_password_hash = await bcrypt.hash(new_password, BCRYPT_COST);
          await prisma.passwordResetRequest.create({
            data: { user_id: user.id, new_password_hash },
          });
        } else {
          // Already has one open — burn the same bcrypt cost without creating
          // a duplicate, so this branch is not a faster (or differently
          // shaped) response than the one that actually writes a row.
          await burnPasswordCompare(new_password);
        }
      } else {
        await burnPasswordCompare(new_password);
      }

      res.json({
        message: "If this phone number has an account, the office has been notified.",
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
