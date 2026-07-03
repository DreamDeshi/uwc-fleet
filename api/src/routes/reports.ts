import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getTripDayStart, getTripDayEnd, mytDateKey } from "../services/incentiveEngine";
import { palletEquivalents } from "../lib/pallets";
import { leaveCoversDate } from "../services/driverLeave";
import { currentMytMonthBounds, mytDayIndex, mytMonthKey, mytMonthParts, mytMonthStart } from "../lib/myt";
import { attentionConfig, hoursSince } from "../services/attention";

import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("admin"));

const DAY_MS = 24 * 60 * 60 * 1000;

// On-time proxy: every stop was delivered on (or before) the same MYT
// calendar day it was picked up — i.e. the run didn't spill into the next day.
// No scheduled per-stop ETA is stored, so this is the best honest signal of a
// trip that completed as planned. Day binning is explicit MYT (lib/myt.ts),
// matching the engine's trip-days regardless of the server's TZ env.
function tripOnTime(pickup: Date, stops: { delivered_at: Date | null }[]): boolean {
  const pickupDay = mytDayIndex(new Date(pickup));
  return stops.every((s) => {
    if (!s.delivered_at) return true;
    return mytDayIndex(new Date(s.delivered_at)) <= pickupDay;
  });
}

// ── GET /reports/dashboard — headline KPIs for the fleet dashboard ──
router.get("/dashboard", async (_req, res, next) => {
  try {
    const now = new Date();
    const dayStart = getTripDayStart(now);
    const dayEnd = getTripDayEnd(now);
    const { start: monthStart } = currentMytMonthBounds(now);

    const [
      totalTrucks,
      activeTruckGroups,
      tripsToday,
      tripsInProgress,
      completedToday,
      pendingApprovals,
      pendingTrips,
      autoDispatchFailed,
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
      // Pending bookings the auto-dispatcher couldn't place — the "needs
      // attention" subset of pending (Phase 2). Self-clearing flag, so this only
      // counts trips still pending AND flagged.
      prisma.trip.count({ where: { status: "pending", auto_dispatch_failed: true } }),
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
      // Split the conflated "unassigned" count: auto-dispatch FAILED (needs
      // attention) vs simply AWAITING MANUAL dispatch. failed ⊆ pending.
      auto_dispatch_failed: autoDispatchFailed,
      awaiting_manual: Math.max(0, pendingTrips - autoDispatchFailed),
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
    const { start: monthStart } = currentMytMonthBounds(now);

    const todayKey = mytDateKey(now);
    const drivers = await prisma.user.findMany({
      where: { role: "driver" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        status: true,
        assigned_truck: { select: { plate: true, max_pallets: true } },
        // Current + upcoming leave ranges only (past leave is history, not
        // availability). The dispatch panel checks these against the TRIP'S
        // pickup date client-side for display; enforcement is server-side
        // (auto candidate filter + the /approve DRIVER_ON_LEAVE guard).
        leaves: {
          where: { end_date: { gte: todayKey } },
          orderBy: { start_date: "asc" },
          select: { start_date: true, end_date: true, note: true },
        },
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
      // Committed load = pallets on this driver's truck across BOTH scheduled
      // (assigned) and in-progress trips — this is what the /approve overload
      // guard sums, so the picker's "fits" preview matches the server.
      const activeTrips = d.trips_driven.filter(
        (t) => t.status === "assigned" || t.status === "in_progress"
      );
      // "Busy" (one-active) is now ONLY an in_progress trip — a driver may hold
      // several scheduled (assigned-but-not-started) trips and stay selectable;
      // scheduled overlaps are governed by the SCHEDULING_CONFLICT buffer at
      // assignment, not by hiding the driver here (Phase 1 picker alignment).
      const inProgressTrip = d.trips_driven.find((t) => t.status === "in_progress");
      const scheduledTrips = d.trips_driven.filter((t) => t.status === "assigned").length;
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

      // on_trip ⇐ actually OUT on a trip (in_progress) — the only state that
      // blocks a new assignment. A driver with only scheduled trips is available.
      let derivedStatus: "on_trip" | "available" | "off_duty";
      if (d.status !== "active" || !d.assigned_truck) {
        derivedStatus = "off_duty";
      } else if (inProgressTrip) {
        derivedStatus = "on_trip";
      } else {
        derivedStatus = "available";
      }

      const currentRoute =
        inProgressTrip?.stops[0]?.consignee.area ??
        inProgressTrip?.stops[0]?.consignee.zone_code ??
        null;

      return {
        id: d.id,
        name: d.name,
        phone: d.phone,
        account_status: d.status,
        status: derivedStatus,
        // Leave is DATE-scoped, so it deliberately does not change `status`:
        // a driver on leave today can still be assigned a trip picked up on
        // another date. Consumers badge/block per relevant date.
        on_leave_today: d.leaves.some((l) => leaveCoversDate(l, todayKey)),
        leaves: d.leaves,
        assigned_truck: d.assigned_truck,
        current_load: currentLoad,
        scheduled_trips: scheduledTrips, // assigned-but-not-started trips queued for this driver
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

// ── GET /reports/attention — stuck/stale trips needing a human (read-only) ──
// Complements the pending-only auto_dispatch_failed flag with the three states
// that previously had no visibility at all. Never mutates anything.
router.get("/attention", async (_req, res, next) => {
  try {
    const now = new Date();
    const cfg = attentionConfig();
    const staleCutoff = new Date(now.getTime() - cfg.staleInProgressHours * 60 * 60 * 1000);
    const overdueCutoff = new Date(now.getTime() - cfg.overdueAssignedHours * 60 * 60 * 1000);

    const shape = {
      id: true,
      ticket_number: true,
      status: true,
      pickup_datetime: true,
      truck_plate: true,
      driver: { select: { name: true, phone: true } },
    } as const;

    const [staleInProgress, overdueAssigned, completedNullIncentive, assignedAll] = await Promise.all([
      prisma.trip.findMany({
        where: { status: "in_progress", pickup_datetime: { lt: staleCutoff } },
        select: shape,
        orderBy: { pickup_datetime: "asc" },
      }),
      prisma.trip.findMany({
        where: { status: "assigned", pickup_datetime: { lt: overdueCutoff } },
        select: shape,
        orderBy: { pickup_datetime: "asc" },
      }),
      // Legacy anomaly: completed by an internal driver but pay never written
      // (pre-atomic-finalization data). External trips legitimately have no
      // incentive, so they're excluded.
      prisma.trip.findMany({
        where: { status: "completed", incentive_earned: null, is_external: false, driver_id: { not: null } },
        select: shape,
        orderBy: { pickup_datetime: "asc" },
      }),
      // Leave-collision (client Q3, 3 Jul 2026): assigned trips whose driver
      // has since been put on leave covering the pickup date. Computed
      // dynamically (no stored flag), so it self-clears the moment the leave
      // is removed or the trip is reassigned/unassigned.
      prisma.trip.findMany({
        where: { status: "assigned", driver_id: { not: null } },
        select: {
          ...shape,
          driver_id: true,
          driver: { select: { name: true, phone: true, leaves: { select: { start_date: true, end_date: true } } } },
        },
        orderBy: { pickup_datetime: "asc" },
      }),
    ]);

    const withAge = (t: (typeof staleInProgress)[number]) => ({
      ...t,
      hours_since_pickup: Math.round(hoursSince(t.pickup_datetime, now) * 10) / 10,
    });

    const assignedDriverOnLeave = assignedAll
      .filter((t) =>
        (t.driver?.leaves ?? []).some((l) => leaveCoversDate(l, mytDateKey(t.pickup_datetime)))
      )
      .map(({ driver_id: _dId, driver, ...t }) => ({
        ...t,
        driver: driver ? { name: driver.name, phone: driver.phone } : null,
      }));

    res.json({
      thresholds: cfg,
      stale_in_progress: staleInProgress.map(withAge),
      overdue_assigned: overdueAssigned.map(withAge),
      completed_null_incentive: completedNullIncentive.map(withAge),
      assigned_driver_on_leave: assignedDriverOnLeave.map(withAge),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /reports/monthly — last 6 calendar months of trip/incentive totals ──
router.get("/monthly", async (_req, res, next) => {
  try {
    // 6-month window and bucket keys in explicit MYT (lib/myt.ts).
    const now = new Date();
    const { year: mytYear, month: mytMonth } = mytMonthParts(now);
    const windowStart = mytMonthStart(mytYear, mytMonth - 5);

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
      // Date.UTC normalises out-of-range month indices across year boundaries.
      const d = new Date(Date.UTC(mytYear, mytMonth - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      buckets[key] = {
        month: key,
        label: `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        trips: 0,
        completed: 0,
        incentive: 0,
        external: 0,
      };
    }

    for (const t of trips) {
      const key = mytMonthKey(new Date(t.pickup_datetime));
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
