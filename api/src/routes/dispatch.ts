import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { prisma } from "../lib/prisma";
import { autoDispatchTrip } from "../services/dispatchEngine";

const router = Router();
router.use(requireAuth, requireRole("admin"));

// ── POST /dispatch/auto — run the engine for one trip and assign it ──
//
// Admin-triggered (the dashboard "auto-assign" action and the auto-mode flow
// both hit this). Returns the assignment + any en-route return-trip offers, or
// 409 NO_TRUCK_AVAILABLE when nothing fits so the trip stays pending.
const autoSchema = z.object({ trip_id: z.string().min(1) });

router.post("/auto", validateBody(autoSchema), async (req, res, next) => {
  try {
    const { trip_id } = req.body;

    const trip = await prisma.trip.findUnique({ where: { id: trip_id }, select: { status: true } });
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
    }
    if (trip.status !== "pending") {
      throw new ApiError(400, "INVALID_STATUS", "Only pending trips can be auto-dispatched.");
    }

    const result = await autoDispatchTrip(trip_id, req.user!.id);
    if (!result.assigned) {
      throw new ApiError(409, "NO_TRUCK_AVAILABLE", result.reason);
    }

    res.json({
      trip: result.trip,
      assignment: result.assignment,
      return_trip_offers: result.returnTripOffers,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
