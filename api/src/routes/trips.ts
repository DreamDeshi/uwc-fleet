import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import {
  calculateDeliveryIncentive,
  getTripDayStart,
  getTripDayEnd,
  isDocumentationComplete,
} from "../services/incentiveEngine";

const router = Router();
router.use(requireAuth);

const tripInclude = {
  requestor: { select: { id: true, name: true, phone: true } },
  driver: { select: { id: true, name: true, phone: true } },
  truck: true,
  route_type: true,
  stops: { include: { consignee: true }, orderBy: { sequence: "asc" as const } },
  cargo_details: true,
};

// ── Ticket number generation: TKT-YYYYMMDD-NNN, sequential per calendar day ──
async function generateTicketNumber(now: Date): Promise<string> {
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}`;
  const dayStart = getTripDayStart(now);
  const dayEnd = getTripDayEnd(now);
  const countToday = await prisma.trip.count({
    where: { created_at: { gte: dayStart, lt: dayEnd } },
  });
  const sequence = String(countToday + 1).padStart(3, "0");
  return `TKT-${datePart}-${sequence}`;
}

// ── POST /trips — requestor submits a booking ───────────────────────────
const createTripSchema = z.object({
  route_type_id: z.string().min(1),
  pickup_datetime: z.coerce.date(),
  is_external: z.boolean().optional(),
  stops: z
    .array(
      z.object({
        consignee_id: z.string().min(1),
        sequence: z.number().int().min(1).optional(),
      })
    )
    .min(1, "At least one stop is required."),
  cargo_details: z
    .array(
      z.object({
        pallet_type: z.string().min(1),
        quantity: z.number().int().min(1),
        cartons: z.number().int().min(0).optional(),
        custom_size: z.string().optional(),
        remark: z.string().optional(),
      })
    )
    .min(1, "At least one cargo line is required."),
});

router.post(
  "/",
  requireRole("requestor", "admin"),
  validateBody(createTripSchema),
  async (req, res, next) => {
    try {
      const { route_type_id, pickup_datetime, is_external, stops, cargo_details } = req.body;

      const routeType = await prisma.routeType.findUnique({ where: { id: route_type_id } });
      if (!routeType) {
        throw new ApiError(400, "ROUTE_TYPE_NOT_FOUND", "Route type does not exist.");
      }

      const consigneeIds = stops.map((s: { consignee_id: string }) => s.consignee_id);
      const foundConsignees = await prisma.consignee.findMany({ where: { id: { in: consigneeIds } } });
      if (foundConsignees.length !== new Set(consigneeIds).size) {
        throw new ApiError(400, "CONSIGNEE_NOT_FOUND", "One or more consignees do not exist.");
      }

      const ticket_number = await generateTicketNumber(new Date());

      const trip = await prisma.trip.create({
        data: {
          ticket_number,
          requestor_id: req.user!.id,
          route_type_id,
          pickup_datetime,
          is_external: is_external ?? false,
          stops: {
            create: stops.map((s: { consignee_id: string; sequence?: number }, idx: number) => ({
              consignee_id: s.consignee_id,
              sequence: s.sequence ?? idx + 1,
            })),
          },
          cargo_details: { create: cargo_details },
        },
        include: tripInclude,
      });

      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.created", table_name: "Trip", record_id: trip.id },
      });

      res.status(201).json(trip);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /trips — role-scoped list ────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const where =
      req.user!.role === "admin"
        ? {}
        : req.user!.role === "driver"
          ? { driver_id: req.user!.id }
          : { requestor_id: req.user!.id };

    const trips = await prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: { created_at: "desc" },
    });
    res.json(trips);
  } catch (err) {
    next(err);
  }
});

// ── GET /trips/:id — detail, role-scoped ─────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const trip = await prisma.trip.findUnique({ where: { id: req.params.id }, include: tripInclude });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }

    const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
    const isDriver = req.user!.role === "driver" && trip.driver_id === req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isDriver && !isAdmin) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to view this trip.");
    }

    res.json(trip);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /trips/:id/approve — admin approves + assigns driver & truck ──
const approveTripSchema = z.object({
  driver_id: z.string().min(1),
  truck_plate: z.string().min(1),
});

router.patch(
  "/:id/approve",
  requireRole("admin"),
  validateBody(approveTripSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { driver_id, truck_plate } = req.body;

      const trip = await prisma.trip.findUnique({ where: { id } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.status !== "pending") {
        throw new ApiError(400, "INVALID_STATUS", "Only pending trips can be approved.");
      }

      const driver = await prisma.user.findUnique({ where: { id: driver_id } });
      if (!driver || driver.role !== "driver") {
        throw new ApiError(400, "DRIVER_NOT_FOUND", "Driver does not exist.");
      }
      if (driver.assigned_truck_plate !== truck_plate) {
        throw new ApiError(
          400,
          "DRIVER_TRUCK_MISMATCH",
          "This driver is not assigned to the given truck."
        );
      }

      const updated = await prisma.trip.update({
        where: { id },
        data: { driver_id, truck_plate, status: "assigned" },
        include: tripInclude,
      });

      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.approved", table_name: "Trip", record_id: id },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/cancel — requestor (owner) or admin cancels a booking ──
// Only while still pending/approved — once a driver is assigned or rolling,
// cancellation must be coordinated by an admin (out of scope for the app).
router.patch("/:id/cancel", async (req, res, next) => {
  try {
    const { id } = req.params;
    const trip = await prisma.trip.findUnique({ where: { id } });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }

    const isOwner = req.user!.role === "requestor" && trip.requestor_id === req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isAdmin) {
      throw new ApiError(403, "FORBIDDEN", "You cannot cancel this booking.");
    }
    if (trip.status !== "pending" && trip.status !== "approved") {
      throw new ApiError(
        400,
        "INVALID_STATUS",
        "Only bookings that have not been assigned yet can be cancelled."
      );
    }

    const updated = await prisma.trip.update({
      where: { id },
      data: { status: "cancelled" },
      include: tripInclude,
    });
    await prisma.auditLog.create({
      data: { user_id: req.user!.id, action: "trip.cancelled", table_name: "Trip", record_id: id },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /trips/:id/stops/:stopId/docs — driver confirms a stop's documents ──
// Photo upload is out of scope for this phase, so the driver confirms the DO
// (and the K2 customs form for K2 destinations) with a checkbox. These flags
// gate the "delivered" action below via isDocumentationComplete().
const stopDocsSchema = z.object({
  do_uploaded: z.boolean().optional(),
  k2_form_ack: z.boolean().optional(),
});

router.patch(
  "/:id/stops/:stopId/docs",
  requireRole("driver"),
  validateBody(stopDocsSchema),
  async (req, res, next) => {
    try {
      const { id, stopId } = req.params;
      const { do_uploaded, k2_form_ack } = req.body;

      const trip = await prisma.trip.findUnique({ where: { id }, include: { stops: true } });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.driver_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
      }
      const stop = trip.stops.find((s) => s.id === stopId);
      if (!stop) {
        throw new ApiError(400, "STOP_NOT_FOUND", "That stop is not part of this trip.");
      }

      await prisma.tripStop.update({
        where: { id: stopId },
        data: {
          ...(do_uploaded !== undefined ? { do_uploaded } : {}),
          ...(k2_form_ack !== undefined ? { k2_form_ack } : {}),
        },
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "stop.docs_updated", table_name: "TripStop", record_id: stopId },
      });

      const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /trips/:id/status — driver updates status (start/arrived/delivered) ──
const statusUpdateSchema = z.object({
  action: z.enum(["start", "arrived", "delivered"]),
  stop_id: z.string().optional(),
});

router.patch(
  "/:id/status",
  requireRole("driver"),
  validateBody(statusUpdateSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { action, stop_id } = req.body;

      const trip = await prisma.trip.findUnique({
        where: { id },
        include: { stops: { orderBy: { sequence: "asc" } }, truck: true },
      });
      if (!trip) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (trip.driver_id !== req.user!.id) {
        throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
      }

      if (action === "start") {
        if (trip.status !== "assigned") {
          throw new ApiError(400, "INVALID_STATUS", "Only assigned trips can be started.");
        }
        const updated = await prisma.trip.update({
          where: { id },
          data: { status: "in_progress" },
          include: tripInclude,
        });
        await prisma.auditLog.create({
          data: { user_id: req.user!.id, action: "trip.started", table_name: "Trip", record_id: id },
        });
        res.json(updated);
        return;
      }

      // arrived / delivered both act on a specific stop.
      const stop = stop_id
        ? trip.stops.find((s) => s.id === stop_id)
        : trip.stops.find((s) => s.status !== "delivered");
      if (!stop) {
        throw new ApiError(400, "STOP_NOT_FOUND", "No matching stop found for this trip.");
      }

      if (action === "arrived") {
        if (stop.status !== "pending") {
          throw new ApiError(400, "INVALID_STATUS", "This stop has already been marked arrived.");
        }
        await prisma.tripStop.update({
          where: { id: stop.id },
          data: { status: "arrived", arrived_at: new Date() },
        });
        await prisma.auditLog.create({
          data: { user_id: req.user!.id, action: "stop.arrived", table_name: "TripStop", record_id: stop.id },
        });
        const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
        res.json(updated);
        return;
      }

      // action === "delivered"
      const consigneeForGate = await prisma.consignee.findUnique({ where: { id: stop.consignee_id } });
      if (!consigneeForGate) {
        throw new ApiError(400, "CONSIGNEE_NOT_FOUND", "Consignee for this stop no longer exists.");
      }
      if (!isDocumentationComplete(stop, consigneeForGate.zone_code)) {
        throw new ApiError(
          400,
          "DOCUMENTATION_INCOMPLETE",
          "DO photo (and K2 form ack for K2 destinations) must be completed before marking delivered."
        );
      }

      await prisma.tripStop.update({
        where: { id: stop.id },
        data: { status: "delivered", delivered_at: new Date() },
      });
      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "stop.delivered", table_name: "TripStop", record_id: stop.id },
      });

      const remainingStops = await prisma.tripStop.count({
        where: { trip_id: id, status: { not: "delivered" } },
      });

      if (remainingStops > 0) {
        const updated = await prisma.trip.findUnique({ where: { id }, include: tripInclude });
        res.json(updated);
        return;
      }

      // Last stop delivered — finalize the trip and run the incentive engine.
      if (!trip.truck) {
        throw new ApiError(400, "TRUCK_NOT_ASSIGNED", "This trip has no truck assigned.");
      }

      const destinationRate = await prisma.destinationRate.findFirst({
        where: { zone_code: consigneeForGate.zone_code },
      });
      const destinationPoints = destinationRate?.points ?? 1;

      const dayStart = getTripDayStart(trip.pickup_datetime);
      const dayEnd = getTripDayEnd(trip.pickup_datetime);
      const priorTripsToday = await prisma.trip.findMany({
        where: {
          driver_id: req.user!.id,
          status: "completed",
          pickup_datetime: { gte: dayStart, lt: dayEnd },
          id: { not: id },
        },
        orderBy: { pickup_datetime: "asc" },
        include: { stops: { orderBy: { sequence: "asc" }, include: { consignee: true } } },
      });

      let firstTripPointsToday: number | null = null;
      if (priorTripsToday.length > 0) {
        const firstTrip = priorTripsToday[0];
        const firstZone = firstTrip.stops[0]?.consignee.zone_code;
        const firstRate = firstZone
          ? await prisma.destinationRate.findFirst({ where: { zone_code: firstZone } })
          : null;
        firstTripPointsToday = firstRate?.points ?? 1;
      }

      const incentive = calculateDeliveryIncentive({
        pickupDateTime: trip.pickup_datetime,
        destinationPoints,
        completedTripsTodayBeforeThis: priorTripsToday.length,
        firstTripPointsToday,
        truck: {
          daily_deduction_points: trip.truck.daily_deduction_points,
          entitled_claim_weekday: Number(trip.truck.entitled_claim_weekday),
          entitled_claim_offpeak: Number(trip.truck.entitled_claim_offpeak),
        },
      });

      const updated = await prisma.trip.update({
        where: { id },
        data: { status: "completed", incentive_earned: incentive.incentiveAmount },
        include: tripInclude,
      });

      await prisma.auditLog.create({
        data: { user_id: req.user!.id, action: "trip.completed", table_name: "Trip", record_id: id },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
