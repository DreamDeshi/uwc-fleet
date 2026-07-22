import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { inactiveTripIds } from "../lib/locationSelfHeal";

const router = Router();

// Constant-time string compare so the API key check can't be timing-probed.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Auth for POST /locations: accept EITHER a driver's JWT (the phone-GPS path) OR
// the static GPS vendor API key (GPS_VENDOR_API_KEY) in the Authorization: Bearer
// header — the hardware-GPS path. The key lets the third-party GPS devices post
// without a user account. If the bearer token isn't the vendor key we fall back
// to the normal driver-JWT guard, so existing behaviour is unchanged.
function driverOrVendorAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const vendorKey = process.env.GPS_VENDOR_API_KEY;

  if (vendorKey && token && safeEqual(token, vendorKey)) {
    req.gpsVendor = true;
    next();
    return;
  }

  // Not the vendor key — require a valid driver JWT (requireAuth → requireRole).
  requireAuth(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    requireRole("driver")(req, res, next);
  });
}

// A single GPS reading. `recorded_at` is optional so that points which were
// queued offline keep their ORIGINAL capture time when they're finally flushed.
const pointSchema = z.object({
  trip_id: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  recorded_at: z.string().datetime().optional(),
});

// Accept a batch: one point on the live 30s tick, or the whole backlog on a
// reconnect flush. Capped at 500 so a runaway client can't dump unbounded rows.
const bodySchema = z.object({
  points: z.array(pointSchema).min(1).max(500),
});

// ── POST /locations — driver phone posts GPS (live tick + offline flush) ──
//
// GPS source is abstracted behind this single endpoint (Brief §12): phone GPS
// today, a vendor API later — only this handler changes, no schema/app rewrite.
router.post(
  "/",
  driverOrVendorAuth,
  // The GPS vendor key is now accepted at the auth layer, but ingesting the
  // vendor's payload ({ truckId, latitude, longitude, timestamp }) and mapping
  // truckId → truck → active trip is a separate task that isn't built yet. Reject
  // vendor-authed requests clearly (rather than fall into the driver-only logic
  // below, which needs req.user). A valid key returns 501 — NOT 401 — so the
  // vendor can confirm their key works while we finish the ingestion path.
  (req, res, next) => {
    if (req.gpsVendor) {
      next(
        new ApiError(
          501,
          "NOT_IMPLEMENTED",
          "GPS vendor API key accepted, but device location ingestion is not implemented yet."
        )
      );
      return;
    }
    next();
  },
  validateBody(bodySchema),
  async (req, res, next) => {
  try {
    const driverId = req.user!.id;
    const { points } = req.body as z.infer<typeof bodySchema>;

    // Verify each distinct trip belongs to THIS driver before storing anything
    // (row-level scoping — a driver can only log against their own trips). We do
    // NOT require status === in_progress: a backlog flushed after the trip is
    // completed must still be accepted, otherwise offline points are lost.
    const tripIds = [...new Set(points.map((p) => p.trip_id))];
    const trips = await prisma.trip.findMany({
      where: { id: { in: tripIds } },
      select: { id: true, driver_id: true, status: true },
    });
    const ownByDriver = new Map(trips.map((t) => [t.id, t.driver_id === driverId]));
    // Trips no longer in_progress — the phone's background task uses this to
    // self-stop a trip that ended while the app was closed (e.g. an admin
    // cancelled it). We still ACCEPT the points below (an offline backlog for a
    // just-completed trip must not be lost); this only tells the client to stop
    // capturing NEW fixes for these trips.
    const inactive = inactiveTripIds(trips);

    for (const id of tripIds) {
      if (!ownByDriver.has(id)) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      if (!ownByDriver.get(id)) {
        throw new ApiError(403, "FORBIDDEN", "You are not assigned to this trip.");
      }
    }

    // One insert for the whole batch — a reconnect flush of a big offline
    // backlog is still a single query.
    await prisma.locationLog.createMany({
      data: points.map((p) => ({
        trip_id: p.trip_id,
        driver_id: driverId,
        latitude: p.latitude,
        longitude: p.longitude,
        source: "phone", // driver phone GPS (foreground + active-trip only); vendor path stamps "vendor"
        // Points that sat in the phone's offline queue keep their ORIGINAL
        // capture time; live ticks omit it and take the DB default (now).
        ...(p.recorded_at ? { recorded_at: new Date(p.recorded_at) } : {}),
      })),
    });

    res.status(201).json({ accepted: points.length, inactive_trip_ids: inactive });
  } catch (err) {
    next(err);
  }
});

export default router;
