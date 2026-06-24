import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("driver"));

// A single GPS reading. `recorded_at` is optional so that points which were
// queued offline keep their ORIGINAL capture time when they're finally flushed.
const pointSchema = z.object({
  trip_id: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  recorded_at: z.string().datetime().optional(),
});

// Accept a batch: one point on the live 30s tick, or the whole backlog on a
// reconnect flush. Capped at 500 so a runaway client can't dump unbounded rows.
const bodySchema = z.object({
  points: z.array(pointSchema).min(1).max(500),
});

// ── POST /locations — driver phone posts GPS (live tick + offline flush) ──
//
// GPS source is abstracted behind this single endpoint (Brief §12): phone GPS
// today, a vendor API later — only this handler changes, no schema/app rewrite.
router.post("/", validateBody(bodySchema), async (req, res, next) => {
  try {
    const driverId = req.user!.id;
    const { points } = req.body as z.infer<typeof bodySchema>;

    // Verify each distinct trip belongs to THIS driver before storing anything
    // (row-level scoping — a driver can only log against their own trips). We do
    // NOT require status === in_progress: a backlog flushed after the trip is
    // completed must still be accepted, otherwise offline points are lost.
    const tripIds = [...new Set(points.map((p) => p.trip_id))];
    const trips = await prisma.trip.findMany({
      where: { id: { in: tripIds } },
      select: { id: true, driver_id: true },
    });
    const ownByDriver = new Map(trips.map((t) => [t.id, t.driver_id === driverId]));

    for (const id of tripIds) {
      if (!ownByDriver.has(id)) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (!ownByDriver.get(id)) {
        throw new ApiError(403, "FORBIDDEN", "You are not assigned to this trip.");
      }
    }

    await prisma.locationLog.createMany({
      data: points.map((p) => ({
        trip_id: p.trip_id,
        driver_id: driverId,
        latitude: p.latitude,
        longitude: p.longitude,
        ...(p.recorded_at ? { recorded_at: new Date(p.recorded_at) } : {}),
      })),
    });

    res.status(201).json({ accepted: points.length });
  } catch (err) {
    next(err);
  }
});

export default router;
