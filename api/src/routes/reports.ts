import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getTripDayStart, getTripDayEnd, mytDateKey } from "../services/incentiveEngine";
import { palletEquivalents } from "../lib/pallets";
import { leaveCoversDate } from "../services/driverLeave";
import {
  currentMytMonthBounds,
  inMytMonth,
  mytDayIndex,
  mytMonthBoundsForKey,
  mytMonthKey,
  mytMonthParts,
  mytMonthStart,
} from "../lib/myt";
import { ApiError } from "../lib/apiError";
import { buildPayrollRows } from "../services/payroll";
import {
  firstEarningInstant,
  payAttributionInstant,
  payableIncentive,
} from "../services/tripCompletion";
import { EARNING_STOP_SELECT, earnedInWindow } from "../services/undeliveredPay";
import { attentionConfig, hoursSince } from "../services/attention";
import { isFullyDelivered, isTripOnTime } from "../lib/performanceScore";
import { earlyTapDistanceM, isEarlyTap } from "../lib/earlyTap";
import { consolidationSavingsFromTotals } from "../lib/consolidationSavings";
import { rightSizingSavings } from "../lib/rightSizingSavings";

import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("admin"));

const DAY_MS = 24 * 60 * 60 * 1000;

// ── GET /reports/dashboard — headline KPIs for the fleet dashboard ──
router.get("/dashboard", async (_req, res, next) => {
  try {
    const now = new Date();
    const dayStart = getTripDayStart(now);
    const dayEnd = getTripDayEnd(now);
    // Both bounds: a lower bound alone lets a booked-ahead trip completed
    // early leak next month's figure into this month's KPI (finding 1.3).
    const { start: monthStart, end: monthEnd } = currentMytMonthBounds(now);

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
        // FULLY delivered completions only: a partial abort (28 Jul rule) ends
        // `completed` with undelivered stops, and counting it here would report
        // a delivery that didn't fully happen.
        where: {
          status: "completed",
          pickup_datetime: { gte: dayStart, lt: dayEnd },
          stops: { every: { status: "delivered" } },
        },
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
      // Superset fetch (delivered-in-month OR picked-up-in-month); the precise
      // pay-day predicate is applied below so the KPI's "this month" agrees
      // with payroll about month-crossing trips.
      prisma.trip.findMany({
        where: {
          status: "completed",
          // Fully delivered only — a partially-delivered abort must not count
          // toward the monthly completed KPI or the on-time rate derived from
          // this set (its never-delivered stops would read as late/served).
          stops: { every: { status: "delivered" } },
          OR: [
            { stops: { some: { delivered_at: { gte: monthStart, lt: monthEnd } } } },
            { pickup_datetime: { gte: monthStart, lt: monthEnd } },
          ],
        },
        // delivered_at alone is correct HERE and nowhere else: the `every`
        // filter above already restricts this set to fully-delivered trips, so
        // no stop in it can be a paid-undelivered one. payAttributionInstant
        // treats the missing widening fields as "delivered-only", which is the
        // right answer for exactly this set.
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

    // "This month" = the pay-attribution month (delivery day), matching payroll.
    const monthCompleted = completedThisMonth.filter((t) =>
      inMytMonth(payAttributionInstant(t), { start: monthStart, end: monthEnd })
    );
    // ONE definition of on time, shared with the driver score (lib/
    // performanceScore). This file used to keep its own copy of the predicate;
    // the copies agreed only because this one pre-filters, and a second copy of
    // a rule is how the e2e window bug survived its first fix.
    const onTimeEligible = monthCompleted.filter((t) => isFullyDelivered(t.stops));
    const onTimeCount = onTimeEligible.filter((t) => isTripOnTime(t.pickup_datetime, t.stops)).length;
    const onTimeRate =
      onTimeEligible.length > 0
        ? Math.round((onTimeCount / onTimeEligible.length) * 1000) / 10
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
    const monthBounds = currentMytMonthBounds(now);

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
            incentive_final: true,
            pickup_datetime: true,
            cargo_details: { select: { pallet_type: true, quantity: true, estimated_pallets: true } },
            // All stops (not take:1): the pay instants across the whole trip
            // feed the month bucket; stops[0] still carries the route label.
            // EARNING_STOP_SELECT, because this drives "Earned (mo.)" and it
            // must bucket identically to the payroll sheet.
            stops: {
              orderBy: { sequence: "asc" },
              select: { ...EARNING_STOP_SELECT, consignee: { select: { area: true, zone_code: true } } },
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
      // Same [start, end) predicate as buildDriverPerformance (users.ts), so
      // the "Earned (mo.)" figure here and the performance page can never
      // disagree on which trips are "this month" (finding 1.3) — keyed on the
      // pay-attribution instant (delivery day), matching payroll.
      const monthTrips = d.trips_driven.filter(
        (t) => t.status === "completed" && inMytMonth(payAttributionInstant(t), monthBounds)
      );
      const tripsToday = d.trips_driven.filter((t) => {
        const p = new Date(t.pickup_datetime);
        return p >= dayStart && p < dayEnd;
      }).length;
      const incentiveThisMonth = monthTrips.reduce((sum, t) => sum + payableIncentive(t), 0);

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

    // Early-tap review flags (lib/earlyTap): deliveries confirmed far from the
    // consignee's stored coordinate. DETECTION ONLY — computed at read time
    // from LocationLog, no stored flag, so it can never block a delivery,
    // alter pay, or gate finalization. Consignees without coords never appear
    // (coord presence is the gate — geocode_match_type is never read). Scope:
    // last 7 days, so the review list self-expires. Two indexed findFirsts per
    // candidate stop ((trip_id, recorded_at) index) — trial-scale volumes.
    const EARLY_TAP_LOOKBACK_DAYS = 7;
    const deliveredCutoff = new Date(now.getTime() - EARLY_TAP_LOOKBACK_DAYS * DAY_MS);
    const candidateStops = await prisma.tripStop.findMany({
      where: {
        delivered_at: { gte: deliveredCutoff },
        consignee: { latitude: { not: null }, longitude: { not: null } },
        trip: { driver_id: { not: null } },
      },
      select: {
        id: true,
        delivered_at: true,
        consignee: { select: { company_name: true, latitude: true, longitude: true } },
        trip: { select: shape },
      },
      orderBy: { delivered_at: "desc" },
    });
    const earlyTapDelivery: object[] = [];
    for (const stop of candidateStops) {
      if (!stop.delivered_at) continue;
      const [before, after] = await Promise.all([
        prisma.locationLog.findFirst({
          where: { trip_id: stop.trip.id, recorded_at: { lte: stop.delivered_at } },
          orderBy: { recorded_at: "desc" },
          select: { latitude: true, longitude: true, recorded_at: true },
        }),
        prisma.locationLog.findFirst({
          where: { trip_id: stop.trip.id, recorded_at: { gte: stop.delivered_at } },
          orderBy: { recorded_at: "asc" },
          select: { latitude: true, longitude: true, recorded_at: true },
        }),
      ]);
      const fixes = [before, after]
        .filter((f): f is NonNullable<typeof f> => f !== null)
        .map((f) => ({
          latitude: Number(f.latitude),
          longitude: Number(f.longitude),
          recorded_at: f.recorded_at,
        }));
      const distanceM = earlyTapDistanceM(
        stop.delivered_at,
        fixes,
        stop.consignee,
        cfg.earlyTapWindowMin
      );
      if (isEarlyTap(distanceM, cfg.earlyTapRadiusM)) {
        earlyTapDelivery.push({
          ...withAge(stop.trip),
          stop_id: stop.id,
          consignee_name: stop.consignee.company_name,
          delivered_at: stop.delivered_at,
          distance_m: distanceM,
        });
      }
    }

    res.json({
      thresholds: cfg,
      stale_in_progress: staleInProgress.map(withAge),
      overdue_assigned: overdueAssigned.map(withAge),
      completed_null_incentive: completedNullIncentive.map(withAge),
      assigned_driver_on_leave: assignedDriverOnLeave.map(withAge),
      early_tap_delivery: earlyTapDelivery,
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

    // Superset fetch: a trip picked up before the window but delivered inside
    // it still belongs to a window month (pay-day attribution); the bucket
    // lookup below drops anything that resolves outside the window.
    const trips = await prisma.trip.findMany({
      where: {
        OR: [
          { pickup_datetime: { gte: windowStart } },
          { stops: { some: earnedInWindow({ gte: windowStart }) } },
        ],
      },
      select: {
        status: true,
        incentive_earned: true,
        incentive_final: true,
        is_external: true,
        pickup_datetime: true,
        stops: { select: EARNING_STOP_SELECT },
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
      // A trip's month is its pay-attribution month: the delivery day for
      // delivered trips (matching payroll), pickup for everything not yet
      // delivered — so the incentive column can never disagree with the
      // payroll sheet about a month-crossing trip.
      const key = mytMonthKey(payAttributionInstant(t));
      const b = buckets[key];
      if (!b) continue;
      b.trips += 1;
      if (t.status === "completed") {
        b.completed += 1;
        b.incentive += payableIncentive(t);
      }
      if (t.is_external) b.external += 1;
    }

    res.json(Object.values(buckets));
  } catch (err) {
    next(err);
  }
});

// ── GET /reports/payroll?month=YYYY-MM — the clerk's month-end sheet ─────
// One row per driver (name, employee no, trip count, RM total) plus per-trip
// lines for dispute tracing. Defaults to the current MYT month; any month is
// selectable. Totals are sums of the STORED per-trip incentive_earned — this
// endpoint never computes pay.
router.get("/payroll", async (req, res, next) => {
  try {
    const monthKey =
      typeof req.query.month === "string" && req.query.month.length > 0
        ? req.query.month
        : mytMonthKey(new Date());
    const bounds = mytMonthBoundsForKey(monthKey);
    if (!bounds) {
      throw new ApiError(400, "INVALID_MONTH", "month must be YYYY-MM.");
    }

    const drivers = await prisma.user.findMany({
      where: { role: "driver" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        employee_number: true,
        trips_driven: {
          // Superset SQL bound (EARNED-in-month OR picked-up-in-month, the
          // latter covering the legacy null-delivered_at fallback);
          // buildPayrollRows applies the precise pay-day [start, end) predicate.
          // `earnedInWindow` (not a bare delivered_at bound) is load-bearing:
          // a trip whose stops ALL failed and were adjudicated has no delivery
          // confirm, so a delivered-only bound would drop it from this month
          // AND — because its pickup can sit in another month — from every
          // other month's sheet too. Real pay, invisible on payroll.
          where: {
            status: "completed",
            OR: [
              { stops: { some: earnedInWindow({ gte: bounds.start, lt: bounds.end }) } },
              { pickup_datetime: { gte: bounds.start, lt: bounds.end } },
            ],
          },
          select: {
            id: true,
            ticket_number: true,
            pickup_datetime: true,
            incentive_earned: true,
            incentive_final: true,
            stops: { select: EARNING_STOP_SELECT },
          },
        },
      },
    });

    const rows = buildPayrollRows(
      drivers.map((d) => ({
        id: d.id,
        name: d.name,
        employee_number: d.employee_number,
        trips: d.trips_driven.map((t) => ({
          id: t.id,
          ticket_number: t.ticket_number,
          pickup_datetime: t.pickup_datetime,
          // The EARNING instant, not the delivery confirm — this is the field
          // buildPayrollRows buckets and sorts on.
          delivered_at: firstEarningInstant(t.stops),
          incentive_earned: t.incentive_earned,
          incentive_final: t.incentive_final,
        })),
      })),
      bounds
    );

    res.json({ month: monthKey, drivers: rows });
  } catch (err) {
    next(err);
  }
});

// GET /reports/consolidation — sustainability KPIs. Deliveries consolidated
// into shared trips is EXACT (drops − trips); the fuel/CO2 figures are
// estimates from tunable averages (see lib/consolidationSavings) and are
// labelled so in the UI. rightSizing adds the smallest-fit dispatch savings
// for the current MYT month (lib/rightSizingSavings — also estimate-labelled).
//
// THE TWO HALVES ARE SCOPED DIFFERENTLY ON PURPOSE, and tests-integration/
// consolidationReport.test.ts pins both so neither drifts into the other:
//   consolidation — SINCE LAUNCH, cumulative. A running total of avoided
//                   journeys is the figure that means anything for a
//                   sustainability claim; it has no month selector because it
//                   is not a period report. The UI says "since launch".
//   rightSizing   — THE RUNNING MYT MONTH, as its subtitle states.
//
// Both are INTERNAL FLEET ONLY. An outsourced trip burned a forwarder's diesel,
// not ours, and every other figure on the Sustainability screen comes from UWC
// fuel logs; rightSizing already drew that line and consolidation now agrees.
const CONSOLIDATION_TRIP_WHERE = { status: "completed" as const, is_external: false };

router.get("/consolidation", async (_req, res, next) => {
  try {
    const bounds = currentMytMonthBounds(new Date());
    const [tripsThatDelivered, dropsDelivered, monthTrips, largest] = await Promise.all([
      // Trips that delivered AT LEAST ONE drop. A completed trip that delivered
      // nothing must not be in this denominator — it would subtract a real
      // saving from the total.
      prisma.trip.count({
        where: { ...CONSOLIDATION_TRIP_WHERE, stops: { some: { status: "delivered" } } },
      }),
      // DELIVERED stops only — see the header of lib/consolidationSavings. The
      // planned itinerary over-claims for every trip that ended early (abort
      // with partial pay leaves unreached stops `pending` on a COMPLETED trip).
      prisma.tripStop.count({
        where: { status: "delivered", trip: CONSOLIDATION_TRIP_WHERE },
      }),
      prisma.trip.findMany({
        where: {
          ...CONSOLIDATION_TRIP_WHERE,
          truck_plate: { not: null },
          pickup_datetime: { gte: bounds.start, lt: bounds.end },
        },
        select: { truck: { select: { type: true } } },
      }),
      prisma.truck.findFirst({
        where: { retired_at: null },
        orderBy: { max_pallets: "desc" },
        select: { type: true },
      }),
    ]);
    res.json({
      ...consolidationSavingsFromTotals(tripsThatDelivered, dropsDelivered),
      rightSizing: rightSizingSavings(
        monthTrips.map((t) => t.truck?.type ?? null),
        largest?.type ?? null
      ),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
