import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { normalizePhone, isNormalizedPhone } from "../lib/phone";
import {
  computeScore,
  isTripOnTime,
  tierForScore,
  percentileBand,
  type DriverTripStats,
} from "../lib/performanceScore";
import { estimateTripDistanceKm } from "../lib/geo";
import { currentMytMonthBounds, inMytMonth } from "../lib/myt";
import { payAttributionInstant } from "../services/tripCompletion";

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
    // "This month" keys on the pay-attribution instant (delivery day) so the
    // points/RM figures agree with the payroll sheet (finding 1.3).
    const completedThisMonth = completed.filter((t) => inMonth(payAttributionInstant(t)));
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

    // Disable guards (no such risk when activating). Mirror the role endpoint:
    // never let an admin lock everyone (incl. themselves) out of the system.
    if (status === "disabled") {
      if (id === req.user!.id) {
        throw new ApiError(400, "CANNOT_DISABLE_SELF", "You cannot disable your own account.");
      }
      if (user.role === "admin") {
        const otherActiveAdmins = await prisma.user.count({
          where: { role: "admin", status: "active", id: { not: id } },
        });
        if (otherActiveAdmins === 0) {
          throw new ApiError(
            409,
            "LAST_ADMIN",
            "Cannot disable the last active admin. Activate or promote another admin first."
          );
        }
      }
      // A driver mid-delivery can't be disabled: status is re-checked on every
      // request, so disabling cuts their login immediately and would STRAND the
      // in_progress trip — there is no admin reassign/complete path for one
      // (unassign/reassign are `assigned`-only). The admin must abort it
      // (PATCH /trips/:id/abort) or let it complete first. Scheduled (assigned,
      // not started) trips are fine — those are reassignable.
      if (user.role === "driver") {
        const activeTrip = await prisma.trip.findFirst({
          where: { driver_id: id, status: "in_progress" },
          select: { ticket_number: true },
        });
        if (activeTrip) {
          throw new ApiError(
            409,
            "DRIVER_ON_ACTIVE_TRIP",
            `This driver is out on trip ${activeTrip.ticket_number}. Abort or complete that trip before disabling them.`
          );
        }
      }
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

const roleSchema = z.object({
  role: z.enum(["admin", "driver", "requestor"]),
});

// PATCH /users/:id/role — admin promotes/demotes an account's role.
// This is the in-app cure for the single-admin SPOF: an existing admin can
// promote a trusted requestor/driver to admin without any DB access, so there
// is always more than one person who can administer the system. Guardrails:
//   - LAST-ADMIN: refuses to move the only remaining ACTIVE admin off the admin
//     role — that would leave nobody able to administer (or to promote a
//     replacement), i.e. re-create the very lockout we're fixing.
//   - TRUCK BINDING: a driver is pinned 1:1 to a truck (assigned_truck_plate is
//     @unique). Promoting AWAY from driver releases that slot (else the plate
//     stays locked to a non-driver and blocks a future assignment); promoting
//     TO driver without a truck is rejected (assign one on the Drivers page
//     first) so we never mint an undispatchable driver.
//   - Audit-logged (from->to), same shape as the approve action.
router.patch("/:id/role", validateBody(roleSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role: newRole } = req.body as { role: "admin" | "driver" | "requestor" };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
    }

    // No-op — nothing to change, nothing to audit.
    if (user.role === newRole) {
      res.json({ id: user.id, role: user.role, status: user.status });
      return;
    }

    // Last-admin guard: count ACTIVE admins OTHER than this user. A disabled
    // admin can't log in, so it doesn't count as a usable fallback.
    if (user.role === "admin" && newRole !== "admin") {
      const otherActiveAdmins = await prisma.user.count({
        where: { role: "admin", status: "active", id: { not: id } },
      });
      if (otherActiveAdmins === 0) {
        throw new ApiError(
          409,
          "LAST_ADMIN",
          "Cannot change the role of the last active admin. Promote another admin first."
        );
      }
    }

    if (newRole === "driver" && !user.assigned_truck_plate) {
      throw new ApiError(
        400,
        "DRIVER_NEEDS_TRUCK",
        "Assign a truck to this account on the Drivers page before making it a driver."
      );
    }
    const releaseTruck = newRole !== "driver" && Boolean(user.assigned_truck_plate);

    const updated = await prisma.user.update({
      where: { id },
      data: {
        role: newRole,
        ...(releaseTruck ? { assigned_truck_plate: null } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `user.role_changed:${user.role}->${newRole}`,
        table_name: "User",
        record_id: id,
      },
    });

    res.json({ id: updated.id, role: updated.role, status: updated.status });
  } catch (err) {
    next(err);
  }
});

// PATCH /users/:id — admin edits a user's IDENTITY fields (name / phone /
// department / employee number). Role and status have their own guarded
// endpoints (/role, /approve); this one deliberately can't touch them. Phone is
// the login ID, so it's normalized, format-checked and kept unique. Audit-logged.
const adminUpdateUserSchema = z
  .object({
    name: z.string().trim().min(1, "Name cannot be empty").optional(),
    phone: z.string().min(1).optional(),
    department_id: z.string().min(1).optional(),
    employee_number: z.string().trim().min(1).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "No fields to update." });

router.patch("/:id", validateBody(adminUpdateUserSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, department_id, employee_number } = req.body as {
      name?: string;
      phone?: string;
      department_id?: string;
      employee_number?: string;
    };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");

    const data: {
      name?: string;
      phone?: string;
      department_id?: string;
      employee_number?: string;
    } = {};
    if (name !== undefined) data.name = name;
    if (employee_number !== undefined) data.employee_number = employee_number;

    if (department_id !== undefined) {
      const dept = await prisma.department.findUnique({ where: { id: department_id } });
      if (!dept) {
        throw new ApiError(400, "DEPARTMENT_NOT_FOUND", "Selected department does not exist.");
      }
      data.department_id = department_id;
    }

    if (phone !== undefined) {
      const normalized = normalizePhone(phone);
      if (!isNormalizedPhone(normalized)) {
        throw new ApiError(400, "INVALID_PHONE", "Enter a valid Malaysian phone number.");
      }
      const clash = await prisma.user.findUnique({ where: { phone: normalized } });
      if (clash && clash.id !== id) {
        throw new ApiError(
          409,
          "PHONE_ALREADY_REGISTERED",
          "Another account already uses this phone number."
        );
      }
      data.phone = normalized;
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        phone: true,
        name: true,
        employee_number: true,
        role: true,
        status: true,
        department_id: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: "user.admin_update",
        table_name: "User",
        record_id: id,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// A truck can be bound to a driver only if it exists, isn't retired, and isn't
// already held by a DIFFERENT driver (the assigned_truck_plate @unique 1:1
// binding). `forDriverId` is the driver we're binding to — a truck already
// bound to THAT same driver is a no-op, not a clash.
const BINDABLE_TRUCK = { id: true, name: true } as const;
async function assertTruckAssignable(plate: string, forDriverId: string | null) {
  const truck = await prisma.truck.findUnique({
    where: { plate },
    include: { driver: { select: BINDABLE_TRUCK } },
  });
  if (!truck) {
    throw new ApiError(404, "TRUCK_NOT_FOUND", "Truck not found.");
  }
  if (truck.retired_at) {
    throw new ApiError(409, "TRUCK_RETIRED", "That truck is retired. Reactivate it before assigning it.");
  }
  if (truck.driver && truck.driver.id !== forDriverId) {
    throw new ApiError(
      409,
      "TRUCK_ALREADY_ASSIGNED",
      `Truck ${plate} is already assigned to ${truck.driver.name}. Free it from that driver first.`
    );
  }
}

// ── POST /users — admin adds a DRIVER to the fleet (FR fleet CRUD) ────────
// The fleet is otherwise seed-only: requestors self-register (→ pending_approval),
// but a NEW driver had no in-app path — so a real hire couldn't be dispatched
// without a re-seed. Creates an ACTIVE driver (an admin is doing this
// deliberately, so it skips the approval queue) with a hashed password and a
// normalized phone, mirroring auth.ts. A truck may be bound now or later via
// PATCH /:id/truck; if given it must be free (1:1) and not retired. Audit-logged.
const createDriverSchema = z.object({
  phone: z.string().min(8, "Phone number is too short"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  name: z.string().trim().min(1, "Name is required"),
  employee_number: z.string().trim().min(1, "Employee number is required"),
  department_id: z.string().min(1, "Department is required"),
  assigned_truck_plate: z.string().trim().min(1).optional(),
});

router.post("/", validateBody(createDriverSchema), async (req, res, next) => {
  try {
    const { password, name, employee_number, department_id, assigned_truck_plate } = req.body as {
      password: string;
      name: string;
      employee_number: string;
      department_id: string;
      assigned_truck_plate?: string;
    };

    const phone = normalizePhone(req.body.phone);
    if (!isNormalizedPhone(phone)) {
      throw new ApiError(400, "INVALID_PHONE", "Enter a valid Malaysian phone number.");
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new ApiError(409, "PHONE_ALREADY_REGISTERED", "An account with this phone number already exists.");
    }

    const department = await prisma.department.findUnique({ where: { id: department_id } });
    if (!department) {
      throw new ApiError(400, "DEPARTMENT_NOT_FOUND", "Selected department does not exist.");
    }

    if (assigned_truck_plate) {
      await assertTruckAssignable(assigned_truck_plate, null);
    }

    const password_hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        phone,
        password_hash,
        name,
        employee_number,
        department_id,
        role: "driver",
        status: "active",
        ...(assigned_truck_plate ? { assigned_truck_plate } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `driver.created${assigned_truck_plate ? ` truck=${assigned_truck_plate}` : " (no truck)"}`,
        table_name: "User",
        record_id: user.id,
      },
    });

    res.status(201).json({
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      status: user.status,
      assigned_truck_plate: user.assigned_truck_plate,
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /users/:id/truck — assign / reassign / free a driver's truck ────
// The 1:1 driver↔truck binding (assigned_truck_plate @unique) previously could
// only be CLEARED as a side effect of promoting away from driver — there was no
// way to bind a truck to a driver, so a fresh driver stayed undispatchable and
// a departed driver's truck stayed locked. `{ plate }` binds (validated free +
// not retired); `{ plate: null }` frees it (the "free a departed driver's truck"
// path). Blocked while the driver holds an active trip so trip↔truck can't
// desync. Audit-logged.
const assignTruckSchema = z.object({
  plate: z.string().trim().min(1).nullable(),
});

router.patch("/:id/truck", validateBody(assignTruckSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { plate } = req.body as { plate: string | null };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
    }
    if (user.role !== "driver") {
      throw new ApiError(400, "NOT_A_DRIVER", "Only a driver account can be assigned a truck.");
    }

    // Changing the truck under a live trip would desync the trip's truck from
    // the driver's — block until the trip is completed or reassigned.
    const activeTrip = await prisma.trip.findFirst({
      where: { driver_id: id, status: { in: ["assigned", "in_progress"] } },
      select: { id: true },
    });
    if (activeTrip) {
      throw new ApiError(
        409,
        "DRIVER_HAS_ACTIVE_TRIP",
        "This driver has an active trip. Complete or reassign it before changing their truck."
      );
    }

    if (plate) {
      await assertTruckAssignable(plate, id);
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { assigned_truck_plate: plate },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: plate
          ? `driver.truck_assigned:${plate}`
          : `driver.truck_freed:${user.assigned_truck_plate ?? "—"}`,
        table_name: "User",
        record_id: id,
      },
    });

    res.json({ id: updated.id, assigned_truck_plate: updated.assigned_truck_plate });
  } catch (err) {
    next(err);
  }
});

export default router;
