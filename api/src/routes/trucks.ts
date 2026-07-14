import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { getTripDayStart, getTripDayEnd } from "../services/incentiveEngine";
import { palletEquivalents } from "../lib/pallets";
import { loadSpecTrucks } from "../lib/uwcSpec";
import { planRateReset } from "../services/rateReset";
import { effectiveTruckRates, nextMytDayKey } from "../services/pendingRates";
import { currentMytMonthBounds } from "../lib/myt";

const router = Router();
router.use(requireAuth);

const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_WINDOW_DAYS = 30;

// Malaysia is UTC+8 year-round (no daylight saving). Expiry alerts are reckoned
// against the Malaysia-time calendar day so "expires today" is consistent for
// admins regardless of where the server runs.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

// ── Fuel cost tracking (FR-CT5) ──────────────────────────────────────────
// POST is mounted BEFORE the admin-only guard below because drivers also log
// fill-ups (a driver may only log against their own assigned truck).

const fuelSchema = z.object({
  litres: z.number().positive("Litres must be a positive number."),
  cost_rm: z.number().positive("Cost (RM) must be a positive number."),
  odometer_km: z.number().positive("Odometer (km) must be a positive number."),
  // Optional ISO timestamp; defaults to "now". Date-only strings (the admin
  // form sends YYYY-MM-DD) are accepted too.
  logged_at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "logged_at must be a valid date.")
    .optional(),
});

// Decimal columns serialise as strings — coerce to numbers for the client.
function serializeFuelLog(log: {
  id: string;
  truck_plate: string;
  liters: unknown;
  cost: unknown;
  odometer: number | null;
  logged_at: Date;
  driver?: { name: string } | null;
}) {
  return {
    id: log.id,
    truck_plate: log.truck_plate,
    liters: Number(log.liters),
    cost: Number(log.cost),
    odometer: log.odometer,
    logged_at: log.logged_at,
    driver: log.driver ?? null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Roll a set of fuel logs up into the FR-CT5 summary figures. total_km_covered
// is the odometer span (max − min) across logs that recorded an odometer; the
// per-litre / per-km rates are null when their denominator is zero.
function summariseFuel(logs: { liters: unknown; cost: unknown; odometer: number | null }[]) {
  const total_litres = round2(logs.reduce((s, l) => s + Number(l.liters), 0));
  const total_cost_rm = round2(logs.reduce((s, l) => s + Number(l.cost), 0));
  const odos = logs.map((l) => l.odometer).filter((o): o is number => o != null);
  const total_km_covered = odos.length >= 2 ? Math.max(...odos) - Math.min(...odos) : 0;
  return {
    log_count: logs.length,
    total_litres,
    total_cost_rm,
    avg_cost_per_litre: total_litres > 0 ? round2(total_cost_rm / total_litres) : null,
    total_km_covered,
    cost_per_km: total_km_covered > 0 ? round2(total_cost_rm / total_km_covered) : null,
  };
}

// POST /trucks/:plate/fuel — log a fuel fill-up (admin, or the truck's driver).
router.post(
  "/:plate/fuel",
  requireRole("admin", "driver"),
  validateBody(fuelSchema),
  async (req, res, next) => {
    try {
      const { plate } = req.params;
      const { litres, cost_rm, odometer_km, logged_at } = req.body;

      const truck = await prisma.truck.findUnique({ where: { plate }, select: { plate: true } });
      if (!truck) {
        throw new ApiError(404, "TRUCK_NOT_FOUND", "Truck not found.");
      }

      // A driver may only log fuel against the truck assigned to them.
      if (req.user!.role === "driver") {
        const me = await prisma.user.findUnique({
          where: { id: req.user!.id },
          select: { assigned_truck_plate: true },
        });
        if (me?.assigned_truck_plate !== plate) {
          throw new ApiError(403, "FORBIDDEN", "You can only log fuel for your assigned truck.");
        }
      }

      const log = await prisma.fuelLog.create({
        data: {
          truck_plate: plate,
          driver_id: req.user!.id,
          liters: litres,
          cost: cost_rm,
          odometer: Math.round(odometer_km),
          logged_at: logged_at ? new Date(logged_at) : new Date(),
        },
      });

      res.status(201).json(serializeFuelLog(log));
    } catch (err) {
      next(err);
    }
  }
);

// Everything below is admin-only.
router.use(requireRole("admin"));

// GET /trucks/fuel/summary — current-month (MYT) fuel spend, one row per truck.
// Declared before "/:plate/fuel" so "fuel" isn't captured as a :plate.
router.get("/fuel/summary", async (_req, res, next) => {
  try {
    const { start, end } = currentMytMonthBounds(new Date());
    const trucks = await prisma.truck.findMany({
      orderBy: { plate: "asc" },
      select: {
        plate: true,
        type: true,
        fuel_logs: {
          where: { logged_at: { gte: start, lt: end } },
          select: { liters: true, cost: true, odometer: true },
        },
      },
    });

    res.json(
      trucks.map((t) => ({ plate: t.plate, type: t.type, ...summariseFuel(t.fuel_logs) }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /trucks/:plate/fuel — all fuel logs for a truck (newest first) + summary.
router.get("/:plate/fuel", async (req, res, next) => {
  try {
    const { plate } = req.params;
    const truck = await prisma.truck.findUnique({ where: { plate }, select: { plate: true } });
    if (!truck) {
      throw new ApiError(404, "TRUCK_NOT_FOUND", "Truck not found.");
    }

    const logs = await prisma.fuelLog.findMany({
      where: { truck_plate: plate },
      orderBy: { logged_at: "desc" },
      select: {
        id: true,
        truck_plate: true,
        liters: true,
        cost: true,
        odometer: true,
        logged_at: true,
        driver: { select: { name: true } },
      },
    });

    res.json({ logs: logs.map(serializeFuelLog), summary: summariseFuel(logs) });
  } catch (err) {
    next(err);
  }
});

// Midnight (00:00) MYT of the calendar day `instant` falls on, as a UTC instant.
function mytMidnight(instant: Date): Date {
  const myt = new Date(instant.getTime() + MYT_OFFSET_MS);
  const utcMidnight = Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate());
  return new Date(utcMidnight - MYT_OFFSET_MS);
}

// Whole MYT calendar days from today until `date`. Negative means already
// expired; 0 means it expires today. Compared at MYT midnight so the time of
// day stored on the expiry never skews the count.
function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.round((mytMidnight(date).getTime() - mytMidnight(now).getTime()) / DAY_MS);
}

type ExpiryStatus = "expired" | "expiring_soon" | "ok";

function expiryStatus(daysLeft: number): ExpiryStatus {
  if (daysLeft < 0) return "expired";
  if (daysLeft <= ALERT_WINDOW_DAYS) return "expiring_soon";
  return "ok";
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
            cargo_details: { select: { pallet_type: true, quantity: true, estimated_pallets: true } },
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
        // A staged next-day rate edit, if one is waiting for its cutoff — the
        // rates editor shows "takes effect DATE (MYT)" from this block.
        pending_rates: t.pending_rates_effective
          ? {
              entitled_claim_weekday:
                t.pending_claim_weekday !== null ? Number(t.pending_claim_weekday) : null,
              entitled_claim_offpeak:
                t.pending_claim_offpeak !== null ? Number(t.pending_claim_offpeak) : null,
              daily_deduction_points: t.pending_deduction_points,
              effective_date: t.pending_rates_effective,
            }
          : null,
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

// ── GET /trucks/alerts — maintenance & document-expiry alerts (FR-MT1) ──
//
// Returns every truck with at least one of insurance / permit / road tax that is
// already expired or expiring within 30 days (Malaysia time). Each document
// reports its expiry date, whole days until expiry (negative = expired) and a
// status the dashboard colour-codes.
router.get("/alerts", async (_req, res, next) => {
  try {
    const now = new Date();
    const trucks = await prisma.truck.findMany({
      orderBy: { plate: "asc" },
      select: {
        plate: true,
        type: true,
        insurance_expiry: true,
        permit_expiry: true,
        road_tax_expiry: true,
      },
    });

    const describe = (expiry: Date | null) => {
      const daysLeft = daysUntil(expiry, now);
      return {
        expiry_date: expiry,
        days_until_expiry: daysLeft,
        status: daysLeft === null ? ("ok" as ExpiryStatus) : expiryStatus(daysLeft),
      };
    };

    const payload = trucks
      .map((t) => ({
        plate: t.plate,
        type: t.type,
        insurance: describe(t.insurance_expiry),
        permit: describe(t.permit_expiry),
        road_tax: describe(t.road_tax_expiry),
      }))
      .filter(
        (t) =>
          t.insurance.status !== "ok" ||
          t.permit.status !== "ok" ||
          t.road_tax.status !== "ok"
      );

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// ── POST /trucks/reset-rates — restore all truck rates to UWC spec defaults ──
//
// Re-applies entitled_claim_weekday/_offpeak, daily_deduction_points and
// max_pallets from docs/uwc-spec.json (the SAME source seed.ts reads, so reset
// and a fresh seed never diverge) to every matching truck. Matches by plate;
// never creates or deletes trucks — a spec plate missing from the DB is skipped
// and reported. Money stays Decimal (Prisma coerces the numeric spec values).
// Writes ONE audit row per reset action, recording the plates updated.
//
// Registered as a literal path (no params) so it can't be shadowed by, and
// can't shadow, the `/:plate/rates` route below.
router.post("/reset-rates", async (req, res, next) => {
  try {
    const specTrucks = loadSpecTrucks();
    const dbTrucks = await prisma.truck.findMany({
      select: {
        plate: true,
        entitled_claim_weekday: true,
        entitled_claim_offpeak: true,
        daily_deduction_points: true,
        max_pallets: true,
        pending_claim_weekday: true,
        pending_claim_offpeak: true,
        pending_deduction_points: true,
        pending_rates_effective: true,
      },
    });

    // Next-day cutoff (client rule 3 Jul 2026): the reset's RATE fields are
    // staged like any other rate edit, effective tomorrow (MYT). The planner
    // therefore compares the spec against the rates that will be IN FORCE
    // tomorrow (pending edit if one is staged, else the live value) — so a
    // drifted pending edit is corrected, and a truck already scheduled back
    // to spec isn't re-planned. max_pallets is capacity, not a rate: it still
    // resets immediately.
    const now = new Date();
    const tomorrowInstant = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const effectiveDate = nextMytDayKey(now);

    const plan = planRateReset(
      specTrucks,
      dbTrucks.map((t) => {
        const eff = effectiveTruckRates(t, tomorrowInstant);
        return {
          plate: t.plate,
          entitled_claim_weekday: Number(eff.entitled_claim_weekday),
          entitled_claim_offpeak: Number(eff.entitled_claim_offpeak),
          daily_deduction_points: eff.daily_deduction_points,
          max_pallets: t.max_pallets,
        };
      })
    );

    // Apply the updates + the single audit row atomically. The audit row is
    // written on every reset action (record_id lists the plates updated, or a
    // marker when nothing drifted) so the action is always traceable.
    const auditRecord =
      plan.updated.length > 0
        ? plan.updated.map((u) => u.plate).join(", ")
        : "(none — all trucks already at spec)";
    await prisma.$transaction([
      ...plan.updated.map((u) => {
        const ratesChanged = u.changes.some((c) => c.field !== "max_pallets");
        const palletsChanged = u.changes.some((c) => c.field === "max_pallets");
        return prisma.truck.update({
          where: { plate: u.plate },
          data: {
            ...(palletsChanged ? { max_pallets: u.data.max_pallets } : {}),
            // Stage the FULL spec rate target (not just changed fields) so the
            // pending block reads as one consistent "back to spec" change.
            ...(ratesChanged
              ? {
                  pending_claim_weekday: u.data.entitled_claim_weekday,
                  pending_claim_offpeak: u.data.entitled_claim_offpeak,
                  pending_deduction_points: u.data.daily_deduction_points,
                  pending_rates_effective: effectiveDate,
                }
              : {}),
          },
        });
      }),
      prisma.auditLog.create({
        data: {
          user_id: req.user!.id,
          action: `rate_reset_to_spec (rates effective ${effectiveDate})`,
          table_name: "Truck",
          record_id: auditRecord,
        },
      }),
    ]);

    res.json({
      updated: plan.updated.map((u) => ({ plate: u.plate, changes: u.changes })),
      already_at_spec: plan.alreadyAtSpec,
      skipped: plan.skipped,
      // Rate fields take effect on this MYT day (max_pallets applies now).
      rates_effective_date: effectiveDate,
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /trucks/:plate/documents — update expiry dates (audit-logged) ──
// The roadworthiness gate blocks dispatch on expired insurance/road tax (and
// warns on permit), so admins need a way to record a renewal — without this,
// an expired document would brick the truck until someone edited the DB.
const documentsSchema = z
  .object({
    insurance_expiry: z.coerce.date().nullable().optional(),
    permit_expiry: z.coerce.date().nullable().optional(),
    road_tax_expiry: z.coerce.date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "At least one document date is required.");

router.patch("/:plate/documents", validateBody(documentsSchema), async (req, res, next) => {
  try {
    const { plate } = req.params;
    const truck = await prisma.truck.findUnique({ where: { plate } });
    if (!truck) {
      throw new ApiError(404, "TRUCK_NOT_FOUND", "Truck not found.");
    }

    const { insurance_expiry, permit_expiry, road_tax_expiry } = req.body;
    const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
    const changes: string[] = [];
    if (insurance_expiry !== undefined) changes.push(`insurance ${fmt(truck.insurance_expiry)}→${fmt(insurance_expiry)}`);
    if (permit_expiry !== undefined) changes.push(`permit ${fmt(truck.permit_expiry)}→${fmt(permit_expiry)}`);
    if (road_tax_expiry !== undefined) changes.push(`road_tax ${fmt(truck.road_tax_expiry)}→${fmt(road_tax_expiry)}`);

    const updated = await prisma.truck.update({
      where: { plate },
      data: {
        ...(insurance_expiry !== undefined ? { insurance_expiry } : {}),
        ...(permit_expiry !== undefined ? { permit_expiry } : {}),
        ...(road_tax_expiry !== undefined ? { road_tax_expiry } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `truck.documents_updated ${changes.join(", ")}`,
        table_name: "Truck",
        record_id: plate,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /trucks/:plate/rates — edit incentive claim rates (audit-logged) ──
const rateSchema = z
  .object({
    entitled_claim_weekday: z.number().positive().optional(),
    entitled_claim_offpeak: z.number().positive().optional(),
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

    // Record the old → new of each field that actually changed. AuditLog has no
    // free-text column, so the change summary is encoded into `action` behind a
    // stable "rate.updated" prefix (greppable; no schema change). Only future
    // ASSIGNMENTS are affected — in-flight trips finalize at the rates
    // snapshotted onto them when they were assigned (rate lock), and completed
    // trips keep their stored incentive_earned.
    const changes: string[] = [];
    if (entitled_claim_weekday !== undefined && Number(truck.entitled_claim_weekday) !== entitled_claim_weekday) {
      changes.push(`weekday ${Number(truck.entitled_claim_weekday).toFixed(2)}→${entitled_claim_weekday.toFixed(2)}`);
    }
    if (entitled_claim_offpeak !== undefined && Number(truck.entitled_claim_offpeak) !== entitled_claim_offpeak) {
      changes.push(`offpeak ${Number(truck.entitled_claim_offpeak).toFixed(2)}→${entitled_claim_offpeak.toFixed(2)}`);
    }
    if (daily_deduction_points !== undefined && truck.daily_deduction_points !== daily_deduction_points) {
      changes.push(`deduction ${truck.daily_deduction_points}→${daily_deduction_points}`);
    }

    // Next-day cutoff (client rule 3 Jul 2026): the edit is STAGED, effective
    // from tomorrow (MYT). Today's assignments keep snapshotting today's
    // rates; the maturation sweep folds these in when the day arrives. Every
    // submitted field is staged (even unchanged ones) so a re-edit replaces
    // the previous pending change wholesale instead of merging with it.
    const effective = nextMytDayKey(new Date());
    const updated = await prisma.truck.update({
      where: { plate },
      data: {
        ...(entitled_claim_weekday !== undefined ? { pending_claim_weekday: entitled_claim_weekday } : {}),
        ...(entitled_claim_offpeak !== undefined ? { pending_claim_offpeak: entitled_claim_offpeak } : {}),
        ...(daily_deduction_points !== undefined ? { pending_deduction_points: daily_deduction_points } : {}),
        pending_rates_effective: effective,
      },
    });

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `${changes.length ? `rate.updated ${changes.join(", ")}` : "rate.updated"} (effective ${effective})`,
        table_name: "Truck",
        record_id: plate,
      },
    });

    res.json({
      plate: updated.plate,
      // Live (still-current) rates — unchanged until the cutoff.
      entitled_claim_weekday: Number(updated.entitled_claim_weekday),
      entitled_claim_offpeak: Number(updated.entitled_claim_offpeak),
      daily_deduction_points: updated.daily_deduction_points,
      pending_rates: {
        entitled_claim_weekday:
          updated.pending_claim_weekday !== null ? Number(updated.pending_claim_weekday) : null,
        entitled_claim_offpeak:
          updated.pending_claim_offpeak !== null ? Number(updated.pending_claim_offpeak) : null,
        daily_deduction_points: updated.pending_deduction_points,
        effective_date: updated.pending_rates_effective,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
