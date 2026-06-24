import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";

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

// ── PATCH /users/me — update own language preference ────────────────────
const updateMeSchema = z.object({
  language_pref: z.enum(["en", "ms", "zh"]),
});

router.patch("/me", validateBody(updateMeSchema), async (req, res, next) => {
  try {
    const { language_pref } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { language_pref },
      select: { id: true, language_pref: true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

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
