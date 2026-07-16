import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { estimateTripDistanceKm } from "../lib/geo";
import { currentMytMonthBounds, inMytMonth, mytMonthKey } from "../lib/myt";
import { firstDeliveredAt, payableIncentive } from "../services/tripCompletion";

const router = Router();
router.use(requireAuth);

// ── GET /incentives/mine — the logged-in driver's own earnings ──────────
// Returns a current-month summary plus a trip-by-trip breakdown. Under the
// POD-approval gate (16 Jul 2026) a delivered trip sits in `pending_approval`
// (proposal computed, not yet paid) until an admin approves it → `completed`.
// Both are surfaced so the driver sees "awaiting approval" trips, but only
// APPROVED (completed) money counts toward the month total and is paid — the
// amount shown is `payableIncentive` (admin-edited final, or the proposal for
// pre-gate trips). Money stays the stored Decimal; the client formats it.
router.get("/mine", requireRole("driver"), async (req, res, next) => {
  try {
    const driverId = req.user!.id;

    const rows = await prisma.trip.findMany({
      where: { driver_id: driverId, status: { in: ["pending_approval", "completed"] } },
      select: {
        id: true,
        ticket_number: true,
        status: true,
        pickup_datetime: true,
        incentive_earned: true,
        incentive_final: true,
        truck_plate: true,
        route_type: { select: { name: true } },
        stops: {
          orderBy: { sequence: "asc" },
          select: {
            delivered_at: true,
            consignee: { select: { company_name: true, area: true, zone_code: true } },
          },
        },
        cargo_details: { select: { quantity: true } },
      },
      orderBy: { pickup_datetime: "desc" },
    });

    const trips = rows.map((t) => {
      const pending = t.status === "pending_approval";
      return {
        id: t.id,
        ticket_number: t.ticket_number,
        pickup_datetime: t.pickup_datetime,
        // The first delivery confirm — the instant the rate tier and pay-day
        // attribution actually keyed on; also the month-bucket key below.
        delivered_at: firstDeliveredAt(t.stops),
        // The payable amount (approved final, or proposal for grandfathered
        // trips). For a pending_approval trip this is the PROPOSED figure —
        // flagged `pending` so the UI shows it as awaiting approval, not paid.
        incentive_earned: payableIncentive(t),
        pending, // true while awaiting admin approval (not yet paid)
        truck_plate: t.truck_plate,
        route_type: t.route_type?.name ?? null,
        destination:
          t.stops[0]?.consignee.area ??
          t.stops[0]?.consignee.company_name ??
          t.stops[0]?.consignee.zone_code ??
          null,
        // Estimated round-trip distance (plant → zone → plant) for the earnings
        // summary. Falls back to a zone-centroid estimate; not a billing figure.
        distance_km: estimateTripDistanceKm(t.stops[0]?.consignee.zone_code ?? null),
        pallets: t.cargo_details.reduce((sum, c) => sum + c.quantity, 0),
      };
    });

    // Current-month aggregate in explicit MYT (lib/myt.ts) — the month bucket
    // must match the engine's MYT trip-days regardless of the server's TZ env.
    const now = new Date();
    // Both bounds ([start, end)) — the same predicate the admin reports use,
    // so the driver's own month total always matches theirs (finding 1.3).
    // Keyed on delivered_at (pickup fallback): pay was written on the delivery
    // day, so that's the month the driver actually gets the money in.
    // Only APPROVED (non-pending) trips count toward paid money; a pending
    // proposal is shown in the list but never added to the total.
    const monthBounds = currentMytMonthBounds(now);
    const monthTrips = trips.filter(
      (t) => !t.pending && inMytMonth(new Date(t.delivered_at ?? t.pickup_datetime), monthBounds)
    );
    const monthTotal = monthTrips.reduce((sum, t) => sum + Number(t.incentive_earned ?? 0), 0);
    const monthDistance = monthTrips.reduce((sum, t) => sum + t.distance_km, 0);

    const monthLabel = mytMonthKey(now);

    res.json({
      summary: {
        month: monthLabel, // YYYY-MM in MYT
        total: monthTotal,
        trip_count: monthTrips.length,
        total_distance_km: monthDistance,
        avg_per_trip: monthTrips.length > 0 ? monthTotal / monthTrips.length : 0,
      },
      trips,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
