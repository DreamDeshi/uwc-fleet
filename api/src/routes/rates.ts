import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("admin"));

// ── GET /rates/destinations — destination point values per location/zone ──
router.get("/destinations", async (_req, res, next) => {
  try {
    const rates = await prisma.destinationRate.findMany({
      orderBy: [{ points: "asc" }, { location_name: "asc" }],
      include: { zone: { select: { code: true, name: true } } },
    });
    res.json(rates);
  } catch (err) {
    next(err);
  }
});

// ── GET /rates/audit — latest "who changed what" per truck / destination ──
// Powers the "last updated by X on DATE" note on the Incentive Rates page.
// Returns the most recent rate-change AuditLog entry per record.
router.get("/audit", async (_req, res, next) => {
  try {
    const rows = await prisma.auditLog.findMany({
      where: { table_name: { in: ["Truck", "DestinationRate"] } },
      orderBy: { timestamp: "desc" },
      select: {
        table_name: true,
        record_id: true,
        timestamp: true,
        action: true,
        user: { select: { name: true } },
      },
    });

    // Rows are newest-first, so the first one seen per record is its latest edit.
    const latest = new Map<string, { table_name: string; record_id: string; user_name: string; timestamp: Date; action: string }>();
    for (const r of rows) {
      const key = `${r.table_name}:${r.record_id}`;
      if (latest.has(key)) continue;
      latest.set(key, {
        table_name: r.table_name,
        record_id: r.record_id,
        user_name: r.user?.name ?? "Unknown",
        timestamp: r.timestamp,
        action: r.action,
      });
    }

    res.json([...latest.values()]);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /rates/destinations/:id — edit point value (audit-logged) ──
const pointsSchema = z.object({ points: z.number().int().min(0).max(99) });

router.patch("/destinations/:id", validateBody(pointsSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const rate = await prisma.destinationRate.findUnique({ where: { id } });
    if (!rate) {
      throw new ApiError(404, "RATE_NOT_FOUND", "Destination rate not found.");
    }

    const oldPoints = rate.points;
    const updated = await prisma.destinationRate.update({
      where: { id },
      data: { points: req.body.points },
      include: { zone: { select: { code: true, name: true } } },
    });

    // Encode the old → new into `action` behind a stable "rate.updated" prefix
    // (AuditLog has no free-text column). Only future trips are affected; the
    // engine reads destination points at finalization, so completed trips keep
    // their stored incentive_earned.
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action:
          oldPoints !== req.body.points
            ? `rate.updated points ${oldPoints}→${req.body.points}`
            : "rate.updated",
        table_name: "DestinationRate",
        record_id: id,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
