import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { estimateTripDistanceKm } from "../lib/geo";
import { currentMytMonthBounds, inMytMonth, mytMonthKey, mytMonthParts, mytMonthStart } from "../lib/myt";
import { firstEarningInstant, payableIncentive } from "../services/tripCompletion";
import { EARNING_STOP_SELECT, earnedInWindow } from "../services/undeliveredPay";

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
// ── HOW FAR BACK THIS READS ────────────────────────────────────────────────
//
// It used to read EVERY trip the driver had ever done — no date bound, no take
// — with each trip's stops, exceptions and cargo, on every open of the Earnings
// tab. Unbounded and monotonic, the same shape as the consolidation query fixed
// in PR #74, just growing per-driver instead of fleet-wide.
//
// THE BOUND MUST NOT MOVE A SINGLE DISPLAYED NUMBER, so it is a strict superset
// of everything the screen computes:
//
//   summary          current MYT month, derived below from these rows
//   the week chart   the current Mon-Sun week, which can START IN THE PREVIOUS
//                    MONTH (Mon 29 Jun for a Wed 1 Jul), so a month-only bound
//                    would silently empty two bars
//   awaiting         pending_approval of ANY age — money the driver is owed and
//                    chasing must never age out of his own screen
//   the trip list    history, and the only thing this bound actually shortens
//
// Six months, matching /reports/monthly's window on the admin side.
//
// WARNING: BOUNDED ON THE PAY INSTANT, never on pickup_datetime alone. A trip
// picked up on the last evening of a month and delivered the next morning earns
// in the LATER month; a pickup-only bound drops it from the window while the
// month summary still expects it, and the driver's total silently understates.
// Same predicate the payroll sheet uses (services/undeliveredPay.earnedInWindow)
// — see tests-integration/thisMonthAgreement.
const EARNINGS_WINDOW_MONTHS = 6;

router.get("/mine", requireRole("driver"), async (req, res, next) => {
  try {
    const driverId = req.user!.id;
    const nowForWindow = new Date();
    const { year: winYear, month: winMonth } = mytMonthParts(nowForWindow);
    const windowStart = mytMonthStart(winYear, winMonth - (EARNINGS_WINDOW_MONTHS - 1));

    const rows = await prisma.trip.findMany({
      where: {
        driver_id: driverId,
        OR: [
          // Never ages out: an unapproved proposal is money outstanding.
          { status: "pending_approval" },
          {
            status: "completed",
            OR: [
              { stops: { some: earnedInWindow({ gte: windowStart }) } },
              // NOT redundant with the line above, and not a belt-and-braces
              // widening either — it is the ONLY branch that catches a trip
              // whose pay instant cannot be derived from its stops:
              //   - the legacy anomaly of a stop marked `delivered` with a NULL
              //     delivered_at (real; /reports/attention surfaces it), where
              //     firstEarningInstant returns null and the month bucket falls
              //     back to pickup_datetime — exactly what the summary below
              //     does. Drop this line and that trip's RM leaves the driver's
              //     month total while the payroll sheet still pays it.
              //   - an all-vetoed trip, where no stop matches earnedInWindow at
              //     all, so trip_count and avg_per_trip move.
              // /reports/payroll carries the identical branch for the identical
              // reason. Pinned by "the LEGACY ANOMALY" test.
              { pickup_datetime: { gte: windowStart } },
              // A settlement the driver has just been given must not vanish on
              // the day it happens. An aged proposal is exempt from the window
              // while it is pending; without this it would be erased the moment
              // an admin approved it — the one day the row matters most. Keyed
              // on the APPROVAL instant, so it follows the settlement, not the
              // journey. Can only ADD rows.
              { incentive_approved_at: { gte: windowStart } },
            ],
          },
        ],
      },
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
            ...EARNING_STOP_SELECT,
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
        // The first EARNING instant — the moment the rate tier and pay-day
        // attribution actually keyed on. For an all-failed-but-adjudicated
        // trip (R3 Q11(a)) that is an ARRIVAL, not a delivery confirm; the
        // delivered-only version showed the driver a blank date on a trip he
        // was being paid for.
        delivered_at: firstEarningInstant(t.stops),
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
