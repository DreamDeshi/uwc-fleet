import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();

router.use(requireAuth, requireRole("admin"));

// GET /users — list users, optionally filter by status (e.g. pending_approval)
router.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const users = await prisma.user.findMany({
      where: {
        ...(status ? { status: status as any } : {}),
        ...(role ? { role: role as any } : {}),
      },
      select: {
        id: true,
        phone: true,
        name: true,
        employee_number: true,
        role: true,
        status: true,
        department_id: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

const approveSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

// PATCH /users/:id/approve — admin approves or disables a pending/active account
router.patch("/:id/approve", validateBody(approveSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
    }

    const updated = await prisma.user.update({ where: { id }, data: { status } });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `user.${status}`,
        table_name: "User",
        record_id: id,
      },
    });

    res.json({ id: updated.id, status: updated.status });
  } catch (err) {
    next(err);
  }
});

export default router;
