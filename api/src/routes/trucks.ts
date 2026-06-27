import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { getTripDayStart, getTripDayEnd } from "../services/incentiveEngine";
import { palletEquivalents } from "../lib/pallets";

const router = Router();
router.use(requireAuth, requireRole("admin"));

const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_WINDOW_DAYS = 30;

// Days from now until `date`. Negative means already expired.
function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.ceil((date.getTime() - now.getTime()) / DAY_MS);
}

// ── GET /trucks — full fleet with driver, live load, doc-expiry alerts ──
router.get("/", async (_req, res, next) => {
  try {
    const now = new Date();
    const dayStart = getTripDayStart(now);
    const dayEnd = getTripDayEnd(now);

    const trucks = await prisma.truck.findMany({
      orderBy: { plate: "asc" },
      include: {
        driver: { select: { id: true, name: true, phone: true } },
        trips: {
          where: { status: { in: ["assigned", "in_progress"] } },
          select: {
            id: true,
            status: true,
            cargo_details: { select: { pallet_type: true, quantity: true } },
            stops: {
              orderBy: { sequence: "asc" },
              select: { consignee: { select: { area: true, zone_code: true } } },
            },
          },
        },
      },
    });

    const tripsTodayByTruck = await prisma.trip.groupBy({
      by: ["truck_plate"],
      where: { pickup_datetime: { gte: dayStart, lt: dayEnd }, truck_plate: { not: null } },
      _count: { _all: true },
    });
    const todayCount = new Map(
      tripsTodayByTruck.map((g) => [g.truck_plate as string, g._count._all])
    );

    const payload = trucks.map((t) => {
      // Current load = 4×4-pallet-equivalents on any active trip.
      const activeLoad = t.trips.reduce(
        (sum, trip) => sum + palletEquivalents(trip.cargo_details),
        0
      );
      const inProgress = t.trips.find((trip) => trip.status === "in_progress");
      const currentRoute =
        inProgress?.stops[0]?.consignee.area ??
        inProgress?.stops[0]?.consignee.zone_code ??
        null;

      const docs = [
        { doc: "insurance" as const, expiry: t.insurance_expiry },
        { doc: "permit" as const, expiry: t.permit_expiry },
        { doc: "road_tax" as const, expiry: t.road_tax_expiry },
      ];
      const alerts = docs
        .map((d) => ({ ...d, daysLeft: daysUntil(d.expiry, now) }))
        .filter((d) => d.daysLeft !== null && d.daysLeft <= ALERT_WINDOW_DAYS);

      const status = inProgress
        ? "active"
        : t.is_available
          ? "idle"
          : "maintenance";

      return {
        plate: t.plate,
        type: t.type,
        max_pallets: t.max_pallets,
        entitled_claim_weekday: Number(t.entitled_claim_weekday),
        entitled_claim_offpeak: Number(t.entitled_claim_offpeak),
        daily_deduction_points: t.daily_deduction_points,
        priority_zones: t.priority_zones,
        operating_hours_start: t.operating_hours_start,
        operating_hours_end: t.operating_hours_end,
        insurance_expiry: t.insurance_expiry,
        permit_expiry: t.permit_expiry,
        road_tax_expiry: t.road_tax_expiry,
        is_available: t.is_available,
        status,
        driver: t.driver,
        current_load: activeLoad,
        current_route: currentRoute,
        trips_today: todayCount.get(t.plate) ?? 0,
        alerts,
      };
    });

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /trucks/:plate/rates — edit incentive claim rates (audit-logged) ──
const rateSchema = z
  .object({
    entitled_claim_weekday: z.number().nonnegative().optional(),
    entitled_claim_offpeak: z.number().nonnegative().optional(),
    daily_deduction_points: z.number().int().nonnegative().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "At least one rate field is required.");

router.patch("/:plate/rates", validateBody(rateSchema), async (req, res, next) => {
  try {
    const { plate } = req.params;
    const truck = await prisma.truck.findUnique({ where: { plate } });
    if (!truck) {
      throw new ApiError(404, "TRUCK_NOT_FOUND", "Truck not found.");
    }

    const { entitled_claim_weekday, entitled_claim_offpeak, daily_deduction_points } = req.body;
    const updated = await prisma.truck.update({
      where: { plate },
      data: {
        ...(entitled_claim_weekday !== undefined ? { entitled_claim_weekday } : {}),
        ...(entitled_claim_offpeak !== undefined ? { entitled_claim_offpeak } : {}),
        ...(daily_deduction_points !== undefined ? { daily_deduction_points } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: "truck.rates_updated",
        table_name: "Truck",
        record_id: plate,
      },
    });

    res.json({
      plate: updated.plate,
      entitled_claim_weekday: Number(updated.entitled_claim_weekday),
      entitled_claim_offpeak: Number(updated.entitled_claim_offpeak),
      daily_deduction_points: updated.daily_deduction_points,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
