import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("admin"));

// How stale a GPS fix can be before we treat the truck as "signal lost".
// Phones ping every 30s, so 3 minutes of silence means something's wrong
// (no signal, app closed, phone off).
const STALE_AFTER_MS = 3 * 60 * 1000;

// ── GET /fleet/live — latest real GPS position of every truck on an active trip ──
//
// One row per in-progress trip that has a truck assigned. Trucks that haven't
// pinged yet simply don't appear here — the admin map falls back to the truck's
// zone centroid for those, so the map is never blank.
router.get("/live", async (_req, res, next) => {
  try {
    const trips = await prisma.trip.findMany({
      where: { status: "in_progress", truck_plate: { not: null } },
      select: {
        id: true,
        ticket_number: true,
        truck_plate: true,
        driver: { select: { id: true, name: true } },
        location_logs: {
          orderBy: { recorded_at: "desc" },
          take: 1,
          select: { latitude: true, longitude: true, recorded_at: true },
        },
      },
    });

    const now = Date.now();
    const positions = trips
      .filter((t) => t.location_logs.length > 0)
      .map((t) => {
        const last = t.location_logs[0];
        const ageMs = now - last.recorded_at.getTime();
        return {
          plate: t.truck_plate!,
          trip_id: t.id,
          ticket_number: t.ticket_number,
          driver: t.driver,
          latitude: Number(last.latitude),
          longitude: Number(last.longitude),
          recorded_at: last.recorded_at,
          stale: ageMs > STALE_AFTER_MS,
        };
      });

    res.json(positions);
  } catch (err) {
    next(err);
  }
});

export default router;
