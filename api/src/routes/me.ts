import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { sensitiveRateLimiter } from "../middleware/rateLimit";

const BCRYPT_COST = 10;

// Mounted at /api/v1/users BEFORE the admin-guarded users router, so that
// GET /api/v1/users/me resolves here (the logged-in user's own profile)
// without requiring the admin role.
const router = Router();
router.use(requireAuth);

// ── GET /users/me — the logged-in user's own profile ────────────────────
router.get("/me", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        phone: true,
        name: true,
        employee_number: true,
        role: true,
        status: true,
        language_pref: true,
        department: { select: { id: true, name: true } },
        assigned_truck: {
          select: { plate: true, type: true, max_pallets: true },
        },
      },
    });
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /users/me — update own profile (name / department / language) ──
// Self-service identity fields ONLY. Phone (the login ID), employee_number,
// role and status are deliberately NOT editable here — phone/employee_number
// are admin-managed (see PATCH /users/:id), role/status never self-set.
const updateMeSchema = z
  .object({
    name: z.string().trim().min(1, "Name cannot be empty").optional(),
    department_id: z.string().min(1).optional(),
    language_pref: z.enum(["en", "ms", "zh"]).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "No fields to update." });

router.patch("/me", validateBody(updateMeSchema), async (req, res, next) => {
  try {
    const { name, department_id, language_pref } = req.body as {
      name?: string;
      department_id?: string;
      language_pref?: "en" | "ms" | "zh";
    };

    if (department_id !== undefined) {
      const dept = await prisma.department.findUnique({ where: { id: department_id } });
      if (!dept) {
        throw new ApiError(400, "DEPARTMENT_NOT_FOUND", "Selected department does not exist.");
      }
    }

    const current = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { name: true, department_id: true },
    });
    if (!current) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");

    const data: { name?: string; department_id?: string; language_pref?: string } = {};
    if (name !== undefined) data.name = name;
    if (department_id !== undefined) data.department_id = department_id;
    if (language_pref !== undefined) data.language_pref = language_pref;

    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      select: {
        id: true,
        phone: true,
        name: true,
        employee_number: true,
        role: true,
        status: true,
        language_pref: true,
        department: { select: { id: true, name: true } },
      },
    });

    // Audit identity changes (name / department). Language toggles are frequent
    // and low-risk, so they stay un-audited (matches prior behaviour).
    const identityChanged =
      (name !== undefined && name !== current.name) ||
      (department_id !== undefined && department_id !== current.department_id);
    if (identityChanged) {
      await prisma.auditLog.create({
        data: {
          user_id: req.user!.id,
          action: "user.self_update",
          table_name: "User",
          record_id: req.user!.id,
        },
      });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /users/me/password — change own password (needs the current one) ──
// Rate-limited (sensitiveRateLimiter). The current session is kept alive
// (refresh_token_hash untouched) so the user isn't logged out of the device
// they just changed it on; other devices keep working until they re-login.
// (Admin-forced resets in auth.ts DO revoke sessions — a different threat model.)
const changePasswordSchema = z.object({
  current_password: z.string().min(1, "Current password is required."),
  new_password: z.string().min(6, "New password must be at least 6 characters."),
});

router.patch(
  "/me/password",
  sensitiveRateLimiter,
  validateBody(changePasswordSchema),
  async (req, res, next) => {
    try {
      const { current_password, new_password } = req.body as {
        current_password: string;
        new_password: string;
      };
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { password_hash: true },
      });
      if (!user) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");

      if (!(await bcrypt.compare(current_password, user.password_hash))) {
        throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "Your current password is incorrect.");
      }
      if (await bcrypt.compare(new_password, user.password_hash)) {
        throw new ApiError(400, "PASSWORD_UNCHANGED", "New password must differ from the current one.");
      }

      const password_hash = await bcrypt.hash(new_password, BCRYPT_COST);
      await prisma.user.update({ where: { id: req.user!.id }, data: { password_hash } });
      await prisma.auditLog.create({
        data: {
          user_id: req.user!.id,
          action: "user.self_password_change",
          table_name: "User",
          record_id: req.user!.id,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /users/push-token — register this device's Expo push token ────
// Called by the mobile app after login. Passing null clears the token (logout).
const pushTokenSchema = z.object({
  expo_push_token: z.string().min(1).nullable(),
});

router.patch("/push-token", validateBody(pushTokenSchema), async (req, res, next) => {
  try {
    const { expo_push_token } = req.body;
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { expo_push_token },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
