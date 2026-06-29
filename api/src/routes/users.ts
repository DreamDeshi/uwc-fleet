import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { computeScore, isTripOnTime, type DriverTripStats } from "../lib/performanceScore";

const router = Router();

router.use(requireAuth, requireRole("admin"));

// Malaysia is UTC+8 year-round; the points component is scoped to the current
// MYT calendar month so a UTC-hosted server still bins trips into the right month.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** [start, end) UTC instants bounding the current Malaysia-time calendar month. */
function currentMytMonthBounds(now: Date): { start: Date; end: Date } {
  const myt = new Date(now.getTime() + MYT_OFFSET_MS);
  const y = myt.getUTCFullYear();
  const m = myt.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1) - MYT_OFFSET_MS),
    end: new Date(Date.UTC(y, m + 1, 1) - MYT_OFFSET_MS),
  };
}

// ── Driver performance scores (FR-FM7) ───────────────────────────────────
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
          stops: { select: { delivered_at: true } },
        },
      },
    },
  });

  const reduced = drivers.map((d) => {
    const completed = d.trips_driven.filter((t) => t.status === "completed");
    const stats: DriverTripStats = {
      totalCompleted: completed.length,
      onTimeCompleted: completed.filter((t) => isTripOnTime(t.pickup_datetime, t.stops)).length,
      cancelled: d.trips_driven.filter((t) => t.status === "cancelled").length,
      pointsThisMonth: completed
        .filter((t) => {
          const p = new Date(t.pickup_datetime);
          return p >= monthStart && p < monthEnd;
        })
        .reduce((sum, t) => sum + Number(t.incentive_earned ?? 0), 0),
    };
    return { driver: d, stats };
  });

  const maxPoints = reduced.reduce((max, r) => Math.max(max, r.stats.pointsThisMonth), 0);

  return reduced.map(({ driver, stats }) => ({
    id: driver.id,
    name: driver.name,
    employee_number: driver.employee_number,
    truck_plate: driver.assigned_truck_plate,
    ...computeScore(stats, maxPoints),
  }));
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
