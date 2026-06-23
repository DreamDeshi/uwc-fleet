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

// ── PATCH /rates/destinations/:id — edit point value (audit-logged) ──
const pointsSchema = z.object({ points: z.number().int().min(0).max(99) });

router.patch("/destinations/:id", validateBody(pointsSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const rate = await prisma.destinationRate.findUnique({ where: { id } });
    if (!rate) {
      throw new ApiError(404, "RATE_NOT_FOUND", "Destination rate not found.");
    }

    const updated = await prisma.destinationRate.update({
      where: { id },
      data: { points: req.body.points },
      include: { zone: { select: { code: true, name: true } } },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: "rate.destination_updated",
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
