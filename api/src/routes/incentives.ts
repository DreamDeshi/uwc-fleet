import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth);

// ── GET /incentives/mine — the logged-in driver's own earnings ──────────
// Returns a current-month summary plus a trip-by-trip breakdown of every
// completed trip. Money stays as the stored Decimal (serialised as string by
// Prisma); the client formats it.
router.get("/mine", requireRole("driver"), async (req, res, next) => {
  try {
    const driverId = req.user!.id;

    const completed = await prisma.trip.findMany({
      where: { driver_id: driverId, status: "completed" },
      select: {
        id: true,
        ticket_number: true,
        pickup_datetime: true,
        incentive_earned: true,
        truck_plate: true,
        route_type: { select: { name: true } },
        stops: {
          orderBy: { sequence: "asc" },
          take: 1,
          select: { consignee: { select: { company_name: true, area: true, zone_code: true } } },
        },
      },
      orderBy: { pickup_datetime: "desc" },
    });

    const trips = completed.map((t) => ({
      id: t.id,
      ticket_number: t.ticket_number,
      pickup_datetime: t.pickup_datetime,
      incentive_earned: t.incentive_earned, // Decimal | null
      truck_plate: t.truck_plate,
      route_type: t.route_type?.name ?? null,
      destination:
        t.stops[0]?.consignee.area ??
        t.stops[0]?.consignee.company_name ??
        t.stops[0]?.consignee.zone_code ??
        null,
    }));

    // Current-month aggregate (server local time — matches the daily-reset
    // assumption documented in the incentive engine).
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTrips = trips.filter((t) => new Date(t.pickup_datetime) >= monthStart);
    const monthTotal = monthTrips.reduce((sum, t) => sum + Number(t.incentive_earned ?? 0), 0);

    const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    res.json({
      summary: {
        month: monthLabel, // YYYY-MM in local time
        total: monthTotal,
        trip_count: monthTrips.length,
      },
      trips,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
