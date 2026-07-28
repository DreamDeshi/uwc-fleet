// In-app user feedback — the owner's channel for bug reports, gripes and
// feature ideas from ANY signed-in role (driver / requestor / admin), asked
// for 28 Jul 2026. Distinct from /client-errors (automatic, uncaught JS
// errors only) and from the driver exception report (delivery incidents).
//
// NO schema change (the Prisma schema is frozen): each submission is an
// AuditLog row — table_name "Feedback", record_id = the category, action =
// the user's text — durable across redeploys (unlike the client-errors
// ring) and joined to the submitting user. Free-text-in-action has
// precedent (abort reasons, rate-edit reasons). If feedback outgrows this,
// a dedicated Feedback table is the upgrade path once a schema change is
// approved.
import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { prisma } from "../lib/prisma";

const router = Router();
router.use(requireAuth);

const CATEGORIES = ["bug", "idea", "other"] as const;

const submitSchema = z.object({
  category: z.enum(CATEGORIES),
  message: z.string().trim().min(5).max(1000),
  screen: z.string().max(200).optional(),
});

// ── POST /feedback — any signed-in user files a bug / idea / gripe ──
router.post("/", validateBody(submitSchema), async (req, res, next) => {
  try {
    const { category, message, screen } = req.body as z.infer<typeof submitSchema>;
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: screen ? `${message}\n[screen: ${screen}]` : message,
        table_name: "Feedback",
        record_id: category,
      },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /feedback — admin reads the inbox, newest first ──
router.get("/", requireRole("admin"), async (_req, res, next) => {
  try {
    const rows = await prisma.auditLog.findMany({
      where: { table_name: "Feedback" },
      orderBy: { timestamp: "desc" },
      take: 200,
      include: { user: { select: { name: true, role: true } } },
    });
    res.json({
      feedback: rows.map((r) => ({
        id: r.id,
        category: r.record_id,
        message: r.action,
        user_name: r.user.name,
        role: r.user.role,
        at: r.timestamp,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
