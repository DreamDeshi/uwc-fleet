import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { resolveFleetFix } from "../lib/gpsPosition";

const router = Router();
router.use(requireAuth, requireRole("admin"));

// ── GET /fleet/live — best real GPS position of every truck on an active trip ──
//
// One row per in-progress trip that has a truck assigned. Each carries a
// `source` ("phone" | "vendor") and a `stale` flag; the resolver prefers the
// freshest vendor fix, then phone (see lib/gpsPosition). Trucks that haven't
// pinged at all don't appear — the admin map falls back to the zone centroid,
// so the map is never blank. Fetch the last 20 logs per trip (>> the 3-min
// fresh window at the 30s cadence) so a fresh vendor fix is always in range.
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
          take: 20,
          select: { latitude: true, longitude: true, recorded_at: true, source: true },
        },
      },
    });

    const now = Date.now();
    const positions = trips.flatMap((t) => {
      const fix = resolveFleetFix(t.location_logs, now);
      if (!fix) return [];
      return [
        {
          plate: t.truck_plate!,
          trip_id: t.id,
          ticket_number: t.ticket_number,
          driver: t.driver,
          latitude: fix.latitude,
          longitude: fix.longitude,
          recorded_at: fix.recorded_at,
          source: fix.source,
          stale: fix.stale,
        },
      ];
    });

    res.json(positions);
  } catch (err) {
    next(err);
  }
});

export default router;
