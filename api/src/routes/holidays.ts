import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth);

// ── GET /holidays — the active public-holiday calendar ──────────────────
// Readable by ANY authenticated user: the mobile app needs it for the driver's
// estimated-incentive display (weekday vs off-peak rate), not just admins.
router.get("/", async (_req, res, next) => {
  try {
    const holidays = await prisma.publicHoliday.findMany({
      orderBy: { date: "asc" },
      select: { id: true, date: true, name: true },
    });
    res.json(holidays);
  } catch (err) {
    next(err);
  }
});

// ── POST /holidays — admin adds a holiday (audit-logged; money-affecting) ──
// `date` is the MYT calendar day as "YYYY-MM-DD" — the exact key the incentive
// engine's off-peak check compares against.
const createHolidaySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.")
    .refine((d) => !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()), "Not a valid date."),
  name: z.string().min(1, "Name is required.").max(120),
});

router.post("/", requireRole("admin"), validateBody(createHolidaySchema), async (req, res, next) => {
  try {
    const { date, name } = req.body;

    const existing = await prisma.publicHoliday.findUnique({ where: { date } });
    if (existing) {
      throw new ApiError(409, "HOLIDAY_EXISTS", `${date} is already in the calendar (${existing.name}).`);
    }

    const holiday = await prisma.publicHoliday.create({ data: { date, name } });
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `holiday.added ${date} (${name})`,
        table_name: "PublicHoliday",
        record_id: holiday.id,
      },
    });
    res.status(201).json(holiday);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /holidays/:id — admin removes a holiday (audit-logged) ──────────
router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const holiday = await prisma.publicHoliday.findUnique({ where: { id } });
    if (!holiday) {
      throw new ApiError(404, "HOLIDAY_NOT_FOUND", "Holiday not found.");
    }

    await prisma.publicHoliday.delete({ where: { id } });
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `holiday.removed ${holiday.date} (${holiday.name})`,
        table_name: "PublicHoliday",
        record_id: id,
      },
    });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
