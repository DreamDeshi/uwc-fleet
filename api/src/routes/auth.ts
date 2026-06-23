import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt";

const router = Router();

const BCRYPT_COST = 10;

// ── POST /auth/register ──────────────────────────────────────────────

const registerSchema = z.object({
  phone: z.string().min(8, "Phone number is too short"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  name: z.string().min(1, "Name is required"),
  employee_number: z.string().optional(),
  department_id: z.string().optional(),
  role: z.enum(["driver", "requestor"]),
});

router.post("/register", validateBody(registerSchema), async (req, res, next) => {
  try {
    const { phone, password, name, employee_number, department_id, role } = req.body;

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new ApiError(409, "PHONE_ALREADY_REGISTERED", "An account with this phone number already exists.");
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

router.post("/login", validateBody(loginSchema), async (req, res, next) => {
  try {
    const { phone, password } = req.body;

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Phone number or password is incorrect.");
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Phone number or password is incorrect.");
    }

    if (user.status === "pending_approval") {
      throw new ApiError(403, "ACCOUNT_PENDING_APPROVAL", "Your account is awaiting admin approval.");
    }
    if (user.status === "disabled") {
      throw new ApiError(403, "ACCOUNT_DISABLED", "Your account has been disabled.");
    }

    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id });
    const refresh_token_hash = await bcrypt.hash(refreshToken, BCRYPT_COST);

    await prisma.user.update({ where: { id: user.id }, data: { refresh_token_hash } });

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

const forgotPasswordSchema = z.object({
  user_id: z.string().min(1),
  new_password: z.string().min(6, "Password must be at least 6 characters"),
});

router.post(
  "/forgot-password",
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
      await prisma.user.update({
        where: { id: user_id },
        data: { password_hash, refresh_token_hash: null },
      });

      res.json({ message: "Password reset successfully." });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
