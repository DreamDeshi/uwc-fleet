import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { assignedLeaveCollisions } from "../services/driverLeave";
import { mytDateKey } from "../services/incentiveEngine";
import { sendPushNotifications } from "../lib/pushNotifications";

// Driver-leave calendar (tracker #4) — admin-managed, DISPATCH-side only.
// Leave never touches pay or login: it removes the driver from the dispatch
// pool for the covered dates (auto candidates + manual approve guard).
const router = Router();
router.use(requireAuth, requireRole("admin"));

// ── GET /leaves — leave entries, newest range first ─────────────────────
router.get("/", async (_req, res, next) => {
  try {
    const leaves = await prisma.driverLeave.findMany({
      orderBy: [{ start_date: "desc" }],
      select: {
        id: true,
        driver_id: true,
        start_date: true,
        end_date: true,
        note: true,
        driver: { select: { name: true, assigned_truck_plate: true } },
      },
    });
    res.json(leaves);
  } catch (err) {
    next(err);
  }
});

// ── POST /leaves — mark a driver on leave for a date or range ────────────
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD.")
  .refine((d) => !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()), "Not a valid date.");

const createLeaveSchema = z
  .object({
    driver_id: z.string().min(1),
    start_date: dateStr,
    // Omitted end = single-day leave.
    end_date: dateStr.optional(),
    note: z.string().max(200).optional(),
  })
  .refine((v) => !v.end_date || v.end_date >= v.start_date, {
    message: "end_date must be on or after start_date.",
  });

router.post("/", validateBody(createLeaveSchema), async (req, res, next) => {
  try {
    const { driver_id, start_date, note } = req.body;
    const end_date = req.body.end_date ?? start_date;

    const driver = await prisma.user.findUnique({ where: { id: driver_id } });
    if (!driver || driver.role !== "driver") {
      throw new ApiError(400, "DRIVER_NOT_FOUND", "Driver does not exist.");
    }

    const leave = await prisma.driverLeave.create({
      data: { driver_id, start_date, end_date, note: note || null },
      select: {
        id: true,
        driver_id: true,
        start_date: true,
        end_date: true,
        note: true,
        driver: { select: { name: true, assigned_truck_plate: true } },
      },
    });
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `leave.added ${start_date}→${end_date}`,
        table_name: "DriverLeave",
        record_id: leave.id,
      },
    });

    // Leave-collision check (client Q3, 3 Jul 2026): leave only blocks NEW
    // assignments — trips ALREADY assigned to this driver for the covered
    // dates need a human to reassign them. Surface them here (response +
    // admin push) and in GET /reports/attention ("assigned_driver_on_leave"),
    // which self-clears once each trip is reassigned or the leave is removed.
    const driverAssigned = await prisma.trip.findMany({
      where: { driver_id, status: "assigned" },
      select: { id: true, ticket_number: true, status: true, pickup_datetime: true },
    });
    const affected = assignedLeaveCollisions(
      driverAssigned,
      { start_date, end_date },
      mytDateKey
    );
    if (affected.length > 0) {
      const admins = await prisma.user.findMany({
        where: { role: "admin", status: "active", expo_push_token: { not: null } },
        select: { expo_push_token: true },
      });
      await sendPushNotifications(
        admins.map((a) => a.expo_push_token),
        {
          title: "Driver on leave — reassign trips",
          body: `${driver.name} is now on leave ${start_date}${
            end_date !== start_date ? ` to ${end_date}` : ""
          } but still has ${affected.length} assigned trip${affected.length === 1 ? "" : "s"} (${affected
            .map((t) => t.ticket_number)
            .join(", ")}). Reassign or unassign them.`,
          data: { type: "leave_collision", driverId: driver_id },
        }
      );
    }

    res.status(201).json({
      ...leave,
      // Assigned trips colliding with this leave — the Drivers page shows
      // these so the admin can jump straight to reassigning.
      affected_trips: affected.map((t) => ({
        id: t.id,
        ticket_number: t.ticket_number,
        pickup_datetime: t.pickup_datetime,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /leaves/:id — remove a leave entry ────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const leave = await prisma.driverLeave.findUnique({ where: { id } });
    if (!leave) {
      throw new ApiError(404, "LEAVE_NOT_FOUND", "Leave entry not found.");
    }

    await prisma.driverLeave.delete({ where: { id } });
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `leave.removed ${leave.start_date}→${leave.end_date}`,
        table_name: "DriverLeave",
        record_id: id,
      },
    });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
