import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import {
  computeScore,
  isTripOnTime,
  tierForScore,
  percentileBand,
  type DriverTripStats,
} from "../lib/performanceScore";
import { estimateTripDistanceKm } from "../lib/geo";
import { currentMytMonthBounds, inMytMonth } from "../lib/myt";

const router = Router();

// ── Driver self-service: my own performance (FR-FM7 personal view) ─────────
// Declared BEFORE the blanket admin guard below so a driver can actually reach
// it. Returns ONLY the caller's own metrics, plus a tier and an anonymous
// percentile band — never another driver's name or score. A driver with no
// completed trips gets has_data:false (null tier/band) so the app shows a
// friendly empty state instead of a misleading Bronze/0.
router.get("/me/performance", requireAuth, requireRole("driver"), async (req, res, next) => {
  try {
    const all = await buildDriverPerformance();
    const mine = all.find((d) => d.id === req.user!.id);
    if (!mine) {
      throw new ApiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
    }

    const hasData = mine.total_completed > 0;
    res.json({
      total_score: mine.total_score,
      tier: hasData ? tierForScore(mine.total_score) : null,
      percentile_band: hasData
        ? percentileBand(mine.total_score, all.map((d) => d.total_score))
        : null,
      on_time_rate: mine.on_time_rate,
      completion_rate: mine.completion_rate,
      total_completed: mine.total_completed,
      rm_earned_this_month: mine.rm_earned_this_month,
      has_data: hasData,
    });
  } catch (err) {
    next(err);
  }
});

// Everything below this guard is admin-only.
router.use(requireAuth, requireRole("admin"));

// ── Driver performance scores (FR-FM7) ───────────────────────────────────
// The points component is scoped to the current MYT calendar month
// (lib/myt.ts) so a UTC-hosted server still bins trips into the right month.
// Builds the score breakdown for every driver. The points component is
// normalised against the top-earning driver this month, so a single driver's
// score still depends on the whole fleet — both endpoints compute the full set.
async function buildDriverPerformance() {
  const { start: monthStart, end: monthEnd } = currentMytMonthBounds(new Date());

  const drivers = await prisma.user.findMany({
    where: { role: "driver" },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      employee_number: true,
      assigned_truck_plate: true,
      trips_driven: {
        select: {
          status: true,
          pickup_datetime: true,
          incentive_earned: true,
          stops: {
            orderBy: { sequence: "asc" },
            select: { delivered_at: true, consignee: { select: { zone_code: true } } },
          },
        },
      },
    },
  });

  // Shared [start, end) predicate (lib/myt) — reports.ts and incentives.ts use
  // the same one, so no endpoint can disagree on "this month" (finding 1.3).
  const inMonth = (d: Date) => inMytMonth(d, { start: monthStart, end: monthEnd });

  const reduced = drivers.map((d) => {
    const completed = d.trips_driven.filter((t) => t.status === "completed");
    const completedThisMonth = completed.filter((t) => inMonth(new Date(t.pickup_datetime)));
    const stats: DriverTripStats = {
      totalCompleted: completed.length,
      onTimeCompleted: completed.filter((t) => isTripOnTime(t.pickup_datetime, t.stops)).length,
      cancelled: d.trips_driven.filter((t) => t.status === "cancelled").length,
      pointsThisMonth: completedThisMonth.reduce(
        (sum, t) => sum + Number(t.incentive_earned ?? 0),
        0
      ),
    };
    // Estimated round-trip km of this month's completed trips (zone-centroid
    // proxy, same basis as the driver earnings summary — not a billing figure).
    const distanceThisMonth = completedThisMonth.reduce(
      (sum, t) => sum + estimateTripDistanceKm(t.stops[0]?.consignee?.zone_code ?? null),
      0
    );
    return { driver: d, stats, distanceThisMonth, completedThisMonth: completedThisMonth.length };
  });

  const maxPoints = reduced.reduce((max, r) => Math.max(max, r.stats.pointsThisMonth), 0);

  return reduced.map(({ driver, stats, distanceThisMonth, completedThisMonth }) => {
    const breakdown = computeScore(stats, maxPoints);
    return {
      id: driver.id,
      name: driver.name,
      employee_number: driver.employee_number,
      truck_plate: driver.assigned_truck_plate,
      // Lets the dashboard distinguish "scored 0" from "no completed trips yet"
      // (a fresh driver shouldn't render a red 0.0 badge).
      total_completed: stats.totalCompleted,
      total_cancelled: stats.cancelled,
      completed_this_month: completedThisMonth,
      distance_km_this_month: distanceThisMonth,
      // Points and RM are the same figure here — incentive_earned is the only
      // per-trip earnings number the schema stores — but both views ask for the
      // metric by name, so expose both keys.
      rm_earned_this_month: breakdown.points_this_month,
      ...breakdown,
    };
  });
}

// GET /users/drivers/performance — all drivers' performance scores (admin only).
// NOTE: declared before "/:id/performance" so "drivers" isn't captured as an :id.
router.get("/drivers/performance", async (_req, res, next) => {
  try {
    res.json(await buildDriverPerformance());
  } catch (err) {
    next(err);
  }
});

// GET /users/:id/performance — a single driver's score breakdown (admin only).
router.get("/:id/performance", async (req, res, next) => {
  try {
    const all = await buildDriverPerformance();
    const one = all.find((d) => d.id === req.params.id);
    if (!one) {
      throw new ApiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
    }
    res.json(one);
  } catch (err) {
    next(err);
  }
});

// GET /users — list users, optionally filter by status (e.g. pending_approval)
router.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const users = await prisma.user.findMany({
      where: {
        ...(status ? { status: status as any } : {}),
        ...(role ? { role: role as any } : {}),
      },
      select: {
        id: true,
        phone: true,
        name: true,
        employee_number: true,
        role: true,
        status: true,
        department_id: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

const approveSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

// PATCH /users/:id/approve — admin approves or disables a pending/active account
router.patch("/:id/approve", validateBody(approveSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
    }

    const updated = await prisma.user.update({ where: { id }, data: { status } });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `user.${status}`,
        table_name: "User",
        record_id: id,
      },
    });

    res.json({ id: updated.id, status: updated.status });
  } catch (err) {
    next(err);
  }
});

export default router;
