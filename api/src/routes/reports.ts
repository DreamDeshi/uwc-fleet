import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getTripDayStart, getTripDayEnd } from "../services/incentiveEngine";
import { palletEquivalents } from "../lib/pallets";

import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("admin"));

const DAY_MS = 24 * 60 * 60 * 1000;

// On-time proxy: every stop was delivered on (or before) the same local
// calendar day it was picked up — i.e. the run didn't spill into the next day.
// No scheduled per-stop ETA is stored, so this is the best honest signal of a
// trip that completed as planned.
function localDayIndex(d: Date): number {
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / (24 * 60 * 60 * 1000)
  );
}
function tripOnTime(pickup: Date, stops: { delivered_at: Date | null }[]): boolean {
  const pickupDay = localDayIndex(new Date(pickup));
  return stops.every((s) => {
    if (!s.delivered_at) return true;
    return localDayIndex(new Date(s.delivered_at)) <= pickupDay;
  });
}

// ── GET /reports/dashboard — headline KPIs for the fleet dashboard ──
router.get("/dashboard", async (_req, res, next) => {
  try {
    const now = new Date();
    const dayStart = getTripDayStart(now);
    const dayEnd = getTripDayEnd(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalTrucks,
      activeTruckGroups,
      tripsToday,
      tripsInProgress,
      completedToday,
      pendingApprovals,
      pendingTrips,
      trucks,
      completedThisMonth,
    ] = await Promise.all([
      prisma.truck.count(),
      prisma.trip.findMany({
        where: { status: "in_progress", truck_plate: { not: null } },
        select: { truck_plate: true },
        distinct: ["truck_plate"],
      }),
      prisma.trip.count({ where: { pickup_datetime: { gte: dayStart, lt: dayEnd } } }),
      prisma.trip.count({ where: { status: "in_progress" } }),
      prisma.trip.count({
        where: { status: "completed", pickup_datetime: { gte: dayStart, lt: dayEnd } },
      }),
      prisma.user.count({ where: { status: "pending_approval" } }),
      prisma.trip.count({ where: { status: "pending" } }),
      prisma.truck.findMany({
        select: { insurance_expiry: true, permit_expiry: true, road_tax_expiry: true },
      }),
      prisma.trip.findMany({
        where: { status: "completed", pickup_datetime: { gte: monthStart } },
        select: { pickup_datetime: true, stops: { select: { delivered_at: true } } },
      }),
    ]);

    // Document-expiry alerts: any truck doc expiring within 30 days (or expired).
    const expiringDocs = trucks.reduce((count, t) => {
      const docs = [t.insurance_expiry, t.permit_expiry, t.road_tax_expiry];
      const flagged = docs.filter((d) => {
        if (!d) return false;
        const days = Math.ceil((d.getTime() - now.getTime()) / DAY_MS);
        return days <= 30;
      }).length;
      return count + flagged;
    }, 0);

    const onTimeCount = completedThisMonth.filter((t) =>
      tripOnTime(t.pickup_datetime, t.stops)
    ).length;
    const onTimeRate =
      completedThisMonth.length > 0
        ? Math.round((onTimeCount / completedThisMonth.length) * 1000) / 10
        : null;

    res.json({
      total_trucks: totalTrucks,
      active_trucks: activeTruckGroups.length,
      trips_today: tripsToday,
      trips_in_progress: tripsInProgress,
      completed_today: completedToday,
      on_time_rate: onTimeRate, // percent, or null when no completed trips this month
      pending_approvals: pendingApprovals,
      pending_trips: pendingTrips,
      alerts: expiringDocs + pendingTrips, // doc expiries + unassigned bookings
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /reports/drivers — per-driver status + this-month performance ──
// Drives both the Driver Management page and the dispatch panel's free-driver
// list (status: on_trip | available | off_duty).
router.get("/drivers", async (_req, res, next) => {
  try {
    const now = new Date();
    const dayStart = getTripDayStart(now);
    const dayEnd = getTripDayEnd(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const drivers = await prisma.user.findMany({
      where: { role: "driver" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        status: true,
        assigned_truck: { select: { plate: true, max_pallets: true } },
        trips_driven: {
          select: {
            status: true,
            incentive_earned: true,
            pickup_datetime: true,
            cargo_details: { select: { pallet_type: true, quantity: true } },
            stops: {
              orderBy: { sequence: "asc" },
              take: 1,
              select: { consignee: { select: { area: true, zone_code: true } } },
            },
          },
        },
      },
    });

    const payload = drivers.map((d) => {
      const activeTrips = d.trips_driven.filter(
        (t) => t.status === "assigned" || t.status === "in_progress"
      );
      const active = activeTrips[0];
      // 4×4-pallet-equivalents already committed to this driver's truck.
      const currentLoad = activeTrips.reduce(
        (sum, t) => sum + palletEquivalents(t.cargo_details),
        0
      );
      const monthTrips = d.trips_driven.filter(
        (t) => t.status === "completed" && new Date(t.pickup_datetime) >= monthStart
      );
      const tripsToday = d.trips_driven.filter((t) => {
        const p = new Date(t.pickup_datetime);
        return p >= dayStart && p < dayEnd;
      }).length;
      const incentiveThisMonth = monthTrips.reduce(
        (sum, t) => sum + Number(t.incentive_earned ?? 0),
        0
      );

      let derivedStatus: "on_trip" | "available" | "off_duty";
      if (d.status !== "active" || !d.assigned_truck) {
        derivedStatus = "off_duty";
      } else if (active) {
        derivedStatus = "on_trip";
      } else {
        derivedStatus = "available";
      }

      const currentRoute = active?.stops[0]?.consignee.area ?? active?.stops[0]?.consignee.zone_code ?? null;

      return {
        id: d.id,
        name: d.name,
        phone: d.phone,
        account_status: d.status,
        status: derivedStatus,
        assigned_truck: d.assigned_truck,
        current_load: currentLoad,
        trips_total: d.trips_driven.filter((t) => t.status === "completed").length,
        trips_this_month: monthTrips.length,
        trips_today: tripsToday,
        incentive_this_month: incentiveThisMonth,
        current_route: currentRoute,
      };
    });

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// ── GET /reports/monthly — last 6 calendar months of trip/incentive totals ──
router.get("/monthly", async (_req, res, next) => {
  try {
    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const trips = await prisma.trip.findMany({
      where: { pickup_datetime: { gte: windowStart } },
      select: {
        status: true,
        incentive_earned: true,
        is_external: true,
        pickup_datetime: true,
      },
    });

    // Pre-seed 6 month buckets so empty months still appear.
    const buckets: Record<
      string,
      { month: string; label: string; trips: number; completed: number; incentive: number; external: number }
    > = {};
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      buckets[key] = {
        month: key,
        label: `${monthNames[d.getMonth()]} ${d.getFullYear()}`,
        trips: 0,
        completed: 0,
        incentive: 0,
        external: 0,
      };
    }

    for (const t of trips) {
      const d = new Date(t.pickup_datetime);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const b = buckets[key];
      if (!b) continue;
      b.trips += 1;
      if (t.status === "completed") {
        b.completed += 1;
        b.incentive += Number(t.incentive_earned ?? 0);
      }
      if (t.is_external) b.external += 1;
    }

    res.json(Object.values(buckets));
  } catch (err) {
    next(err);
  }
});

export default router;
