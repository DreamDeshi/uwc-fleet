import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { estimateTripDistanceKm } from "../lib/geo";
import { currentMytMonthBounds, inMytMonth, mytMonthKey, mytMonthParts, mytMonthStart } from "../lib/myt";
import { firstEarningInstant, payAttributionInstant, payableIncentive } from "../services/tripCompletion";
import { EARNING_STOP_SELECT, earnedInWindow } from "../services/undeliveredPay";
import { countFromEnv } from "../lib/envNumbers";
import {
  DAILY_RESET_HOUR,
  OFFPEAK_CUTOFF_HOUR,
  PEAK_START_HOUR,
} from "../services/incentiveEngine";

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

/**
 * Newest N trips in the LIST. Bounding the payload was the point of the window;
 * without a cap a busy driver's six months is on the order of a thousand trips
 * with nested stops, exceptions and cargo, delivered to a phone.
 *
 * SAFE ONLY BECAUSE THE SUMMARY NO LONGER READS THIS QUERY. While the month
 * total was derived from the list rows, any `take` silently truncated the
 * total — which is why the previous pass deliberately shipped without one and
 * said so. The summary now has its own query below; that is the change that
 * makes a cap possible at all.
 *
 * Truncation is REPORTED, never silent: `truncated` tells the client the list
 * is partial so it can say so. A money list that just stops is the same class
 * of defect as a total that just stops.
 *
 * Read PER REQUEST, not captured at import, for the same reason the feature
 * flags are — and because it is the only way to actually TEST the decoupling:
 * proving the summary survives a truncated list needs a truncated list, and
 * manufacturing 201 real trips through the booking API would take minutes.
 */
function earningsListLimit(): number {
  return countFromEnv("EARNINGS_LIST_LIMIT", 200);
}

// ── GET /incentives/rules — the pay rules, READ OUT OF THE ENGINE ──────────
//
// The admin Incentives screen has a "Formula & Examples" panel that explains
// what the system pays. Until now that explanation was hand-written copy in the
// locale files, and it drifted: it still said the daily deduction came off "the
// first trip of the day" (pre-aa8d081 — it comes off the DAY TOTAL, once,
// floored at zero), called the off-peak band "Weekend / Holiday" (hiding the
// evening case, which is most of what off-peak actually pays for), claimed
// "Malaysian public holidays" (R1 Q5 was explicit — the UWC Batu Kawan list,
// which is why the Perak Sultan's birthday is NOT entitled), and quoted the
// 07:00–02:00 PICKUP window as if it were a rate band.
//
// So the numbers are no longer restated by hand. This endpoint returns the
// engine's OWN exported constants — change PEAK_START_HOUR and the screen
// changes with it, including an env override, which a generated file could not
// show. The prose that surrounds them is pinned by tests on both sides.
//
// Read-only, admin-only, no DB. It describes the rules; it computes no money.
router.get("/rules", requireRole("admin"), (_req, res) => {
  res.json({
    // Rate bands. Peak is [peak_start_hour, offpeak_cutoff_hour) on Mon–Fri;
    // the two bands partition the day, so everything else is off-peak.
    peak_start_hour: PEAK_START_HOUR,
    offpeak_cutoff_hour: OFFPEAK_CUTOFF_HOUR,
    // The incentive day rolls at this MYT hour (Mr. Teh, 3 Jul 2026).
    daily_reset_hour: DAILY_RESET_HOUR,
    // Which instant decides the band and the day: the delivery confirm, not
    // the pickup. Named so the copy cannot quietly say "pickup" again.
    rate_anchor: "delivery_confirm" as const,
    // Where the deduction lands. "day_total" is the post-aa8d081 behaviour.
    deduction_scope: "day_total" as const,
    // Points for a repeat drop into a zone already delivered to that day.
    repeat_zone_points: 1,
    // Holidays come from the admin-managed calendar (UWC's own list), never a
    // national holiday library.
    holiday_source: "admin_calendar" as const,
    // Interplant pays in whole round trips (R5 A2) — live since PR #142.
    interplant_round_trip_halving: true,
  });
});

router.get("/mine", requireRole("driver"), async (req, res, next) => {
  try {
    const driverId = req.user!.id;
    const limit = earningsListLimit();
    const nowForWindow = new Date();
    const { year: winYear, month: winMonth } = mytMonthParts(nowForWindow);
    const windowStart = mytMonthStart(winYear, winMonth - (EARNINGS_WINDOW_MONTHS - 1));

    // ── THE MONTH SUMMARY, FROM ITS OWN QUERY ──────────────────────────────
    //
    // It used to be derived from the list rows, which coupled two unrelated
    // questions: "what did I earn this month" and "what should the breakdown
    // show". That coupling is why the list could not be capped — every `take`
    // was also a cap on the total.
    //
    // Scoped to the CURRENT MONTH and to `completed` only (a pending proposal
    // is shown in the list but is not paid money), with the same superset bound
    // /reports/payroll uses: earned-in-window OR picked-up-in-window, then the
    // precise pay-instant predicate applied in memory. Selects only what the
    // four figures need.
    const monthBounds = currentMytMonthBounds(new Date());
    const summaryRows = await prisma.trip.findMany({
      where: {
        driver_id: driverId,
        status: "completed",
        OR: [
          { stops: { some: earnedInWindow({ gte: monthBounds.start, lt: monthBounds.end }) } },
          { pickup_datetime: { gte: monthBounds.start, lt: monthBounds.end } },
        ],
      },
      select: {
        pickup_datetime: true,
        incentive_earned: true,
        incentive_final: true,
        stops: {
          orderBy: { sequence: "asc" },
          select: { ...EARNING_STOP_SELECT, consignee: { select: { zone_code: true } } },
        },
      },
    });

    // ── THE LIST: TWO QUERIES, BECAUSE ONE CAP WOULD EAT THE WRONG ROWS ────
    //
    // The list is ordered by pickup DESC, so a `take` removes the OLDEST rows.
    // That is precisely the population that is in this list *because it must
    // not age out*:
    //
    //   an aged pending_approval trip   money the driver is owed and chasing
    //   an old trip just settled        the incentive_approved_at branch, added
    //                                   after a money review found the row
    //                                   vanished on the day it was paid
    //
    // Both are old BY CONSTRUCTION — that is what makes them exempt from the
    // window — so a single capped query deletes exactly the rows the two
    // rulings above exist to protect. A money review measured it: with the cap
    // at 1, an eight-month-old RM52 proposal disappeared from the response, and
    // the client's "Awaiting approval" figure is computed FROM THIS LIST
    // (mobile/src/lib/earnings.ts pendingTotal/pendingCount), so the driver's
    // owed money vanished from the only screen that shows it while his month
    // total stayed correct — which is what would have made it unnoticeable.
    //
    // So they are fetched SEPARATELY and never capped. Both are inherently
    // small: one is the office's approval backlog, the other is old work
    // settled inside the window.
    // One select for both list queries, so the two halves of the list cannot
    // come back with different shapes.
    const listSelect = {
      id: true,
      ticket_number: true,
      status: true,
      pickup_datetime: true,
      incentive_earned: true,
      incentive_final: true,
      truck_plate: true,
      route_type: { select: { name: true } },
      stops: {
        orderBy: { sequence: "asc" as const },
        select: {
          ...EARNING_STOP_SELECT,
          consignee: { select: { company_name: true, area: true, zone_code: true } },
        },
      },
      cargo_details: { select: { quantity: true } },
    };

    const keptRows = await prisma.trip.findMany({
      where: {
        driver_id: driverId,
        OR: [
          { status: "pending_approval" },
          {
            status: "completed",
            pickup_datetime: { lt: windowStart },
            incentive_approved_at: { gte: windowStart },
          },
        ],
      },
      select: listSelect,
      orderBy: { pickup_datetime: "desc" },
    });

    // Ordinary recent history — the only thing a cap should ever shorten.
    const historyRows = await prisma.trip.findMany({
      take: limit + 1, // +1 to detect truncation without a second count
      where: {
        driver_id: driverId,
        status: "completed",
        OR: [
          // Keyed on the PAY INSTANT, not pickup — a trip picked up the evening
          // before the window opens and delivered the morning after earned
          // inside it and belongs here. Dropping this branch loses a pre-gate
          // trip (incentive_approved_at null) that the kept-rows query cannot
          // reach either.
          { stops: { some: earnedInWindow({ gte: windowStart }) } },
          { pickup_datetime: { gte: windowStart } },
        ],
      },
      select: listSelect,
      orderBy: { pickup_datetime: "desc" },
    });

    const truncatedHistory = historyRows.length > limit;
    const seen = new Set<string>();
    const rows = [...keptRows, ...historyRows.slice(0, limit)]
      .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .sort((a, b) => b.pickup_datetime.getTime() - a.pickup_datetime.getTime());

    const truncated = truncatedHistory;
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
    const listed = trips;

    // ── THE FOUR FIGURES, FROM summaryRows — NEVER FROM `trips` ────────────
    //
    // Keyed on payAttributionInstant, the SHARED function every other money
    // surface buckets by (services/tripCompletion), rather than re-deriving
    // `delivered_at ?? pickup_datetime` here. The re-derivation was correct but
    // it was a fourth copy of a rule this session has already been bitten by
    // three times; the shared one cannot drift from payroll.
    //
    // Both bounds ([start, end)) — the same predicate the admin reports use, so
    // the driver's own month total always matches theirs (finding 1.3).
    const monthTrips = summaryRows.filter((t) =>
      inMytMonth(payAttributionInstant(t), monthBounds)
    );
    const monthTotal = monthTrips.reduce((sum, t) => sum + payableIncentive(t), 0);
    const monthDistance = monthTrips.reduce(
      (sum, t) => sum + estimateTripDistanceKm(t.stops[0]?.consignee.zone_code ?? null),
      0
    );

    res.json({
      summary: {
        month: mytMonthKey(monthBounds.start), // YYYY-MM in MYT
        total: monthTotal,
        trip_count: monthTrips.length,
        total_distance_km: monthDistance,
        avg_per_trip: monthTrips.length > 0 ? monthTotal / monthTrips.length : 0,
      },
      trips: listed,
      // The list is the newest EARNINGS_LIST_LIMIT, not everything. Said out
      // loud so the client can too — the summary above is complete regardless.
      truncated,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
