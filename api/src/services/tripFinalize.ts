import type { Prisma } from "@prisma/client";
import { ApiError } from "../lib/apiError";
import { loadHolidaySet } from "../lib/holidays";
import { calculateDeliveryIncentive, groupStopsByDeliveryDay, scoreDrops } from "./incentiveEngine";
import { isInterplantRouteType } from "../lib/uwcSpec";
import {
  buildPointsByZone,
  dropZoneCode,
  dropZonePoints,
  finalizationRateParams,
} from "./rateSnapshot";
import { effectiveTruckRates, effectiveZonePoints } from "./pendingRates";
import { collectFinalizeBreakdown, proposeTripIncentiveOnce, type FinalizedGroup } from "./tripCompletion";
import { priorDeliveredDropsWhere } from "./dayLedger";
import { SETTLED_UNDELIVERED_WHERE, stopPayInstant } from "./undeliveredPay";


/**
 * Score THIS trip's DELIVERED stops and PROPOSE the incentive: the per-zone-
 * per-day ledger, snapshot rates and write-once CAS (in_progress →
 * pending_approval, via proposeTripIncentiveOnce) that used to live inline in
 * the final-delivery branch, factored out so the abort path can reuse it
 * verbatim. THREE callers:
 *   - the delivered branch, after the LAST stop's delivered write commits —
 *     every stop is status "delivered" by then, so the status filter below
 *     matches all of them (byte-identical to the pre-extraction inline block);
 *   - the abort route, when an in_progress trip with ≥1 EARNING stop is
 *     aborted (partial-pay rule, Mr. Teh 28 Jul 2026: "yes keep the pay for
 *     those 3" — delivered stops keep their pay; stops the driver never
 *     reached are never scored, so they can't leak a fallback-dated group
 *     into the ledger);
 *   - closing an exception that leaves NO stop outstanding (routes/exceptions
 *     finalizeIfNothingOutstanding) — the R3 Q11(a) single-drop case, where the
 *     last stop is SETTLED rather than delivered and no further delivery event
 *     will ever arrive to trigger finalization. Without that caller such a trip
 *     sat in_progress forever and its pay was reachable only via Abort.
 *
 * Lives in services/ rather than routes/trips so all three share it without a
 * route→route import.
 *
 * Caller must hold lockTripRow(tx, trip.id) and pass a trip row RE-READ under
 * that lock. `driverId` is the TRIP's driver (the ledger owner) — for the
 * abort caller that is trip.driver_id, never the acting admin.
 * Returns the proposed RM, or null when the CAS lost (status moved on or an
 * incentive already exists).
 */
export async function proposeDeliveredStopsIncentive(
  tx: Prisma.TransactionClient,
  trip: Prisma.TripGetPayload<{ include: { truck: true; route_type: true } }>,
  driverId: string
): Promise<number | null> {
  if (!trip.truck) throw new ApiError(400, "TRUCK_NOT_ASSIGNED", "This trip has no truck assigned.");

  // This trip's EARNING drops, each with its zone's full destination points.
  // Scored stop-by-stop (per-zone-per-day), summed.
  //
  // Two kinds earn (services/undeliveredPay.ts owns the rule):
  //   - delivered stops, anchored on delivered_at (unchanged);
  //   - stops the driver REACHED but could not deliver, whose stop-attached
  //     exception the admin resolved — R3 Q11(a) "Same rate paid, although not
  //     delivered" — anchored on arrived_at.
  // A stop the driver never reached still earns nothing (Q11(b)), and a
  // rejected exception is the admin's no-pay lever.
  const now = new Date();
  const candidateStops = await tx.tripStop.findMany({
    where: {
      trip_id: trip.id,
      OR: [{ status: "delivered" }, SETTLED_UNDELIVERED_WHERE],
    },
    include: {
      consignee: { select: { zone_code: true } },
      // These three fields ARE the pay predicate (undeliveredPay.ts). The WHERE
      // above already filtered on them, but stopPayInstant re-checks in memory,
      // so under-selecting here would make every settled stop look ineligible
      // and silently drop it from scoring. Select exactly what the rule reads.
      exceptions: {
        select: {
          current_state: true,
          resolution: true,
          actions: { where: { type: "verify" }, select: { type: true }, take: 1 },
        },
      },
    },
  });
  // Normalise to ONE pay instant per stop, then order by it — the engine's
  // per-zone-per-day scoring depends on the sequence the driver worked in, and
  // an undelivered stop's instant is its arrival, not a delivery it never had.
  //
  // `now` is the fallback for the legacy anomaly of a delivered stop with a
  // NULL delivered_at (real; /reports/attention surfaces them). It matches what
  // groupStopsByDeliveryDay already did with its own fallback — without it the
  // filter below would drop the stop and silently zero a real drop's pay.
  //
  // `real_delivered_at` preserves the TRUE delivery confirm before the
  // overwrite, because the RATE TIER must not be selected by an arrival —
  // see the rateAnchor computation in the group loop below.
  const thisTripStops = candidateStops
    .map((s) => ({ ...s, real_delivered_at: s.delivered_at, delivered_at: stopPayInstant(s, now) }))
    .filter((s) => s.delivered_at !== null)
    .sort((a, b) => a.delivered_at!.getTime() - b.delivered_at!.getTime());
  const zoneCodes = [...new Set(thisTripStops.map((s) => dropZoneCode(s, s.consignee.zone_code)))];
  const rateRows = await tx.destinationRate.findMany({
    where: { zone_code: { in: zoneCodes } },
    select: { zone_code: true, location_name: true, points: true, pending_points: true, pending_points_effective: true },
  });
  const pointsByZone = buildPointsByZone(rateRows.map((r) => ({ ...r, points: effectiveZonePoints(r, new Date()) })));

  // Incentive day keys on DELIVERY confirm time (client rule 3 Jul 2026).
  const dayGroups = groupStopsByDeliveryDay(thisTripStops, new Date());
  const publicHolidays = await loadHolidaySet();
  const truckRates = finalizationRateParams({
    entitled_claim_weekday: trip.entitled_claim_weekday,
    entitled_claim_offpeak: trip.entitled_claim_offpeak,
    daily_deduction_points: trip.daily_deduction_points,
    truck: effectiveTruckRates(trip.truck, new Date()),
  });

  let incentiveThisTrip = 0;
  // Round-trip completeness for the interplant scheme — counted over the WHOLE
  // trip, not a day group, because the round trip is the unit Mr. Teh pays for.
  // Cheap and computed once: the loop below can run more than once on the rare
  // midnight-straddling trip, and this answer must not differ between groups.
  const undeliveredStopCount = await tx.tripStop.count({
    where: { trip_id: trip.id, status: { not: "delivered" } },
  });

  const finalizedGroups: FinalizedGroup[] = [];
  for (const group of dayGroups) {
    // Per-day ledger: drops this driver already DELIVERED earlier today on
    // OTHER in_progress/completed trips (see dayLedger.ts).
    const priorStopsToday = await tx.tripStop.findMany({
      where: priorDeliveredDropsWhere({ driverId, excludeTripId: trip.id, dayStart: group.dayStart, anchor: group.anchor }),
      select: {
        zone_code: true, zone_points: true, arrived_at: true, delivered_at: true, status: true,
        consignee: { select: { zone_code: true } },
        // Same reason as the candidate query: the pay predicate is re-checked
        // in memory below, so it must be able to see all three fields.
        exceptions: {
          select: {
            current_state: true,
            resolution: true,
            actions: { where: { type: "verify" }, select: { type: true }, take: 1 },
          },
        },
      },
    });
    // Ordered by each stop's OWN pay instant (delivered_at, or arrival for a
    // paid-undelivered one) — the same normalisation this trip's stops get.
    // NO `now` fallback here, deliberately: `?? 0` sorts a null-instant row
    // first, which is exactly what this ledger did before, and these rows are
    // only ever a zone LIST for scoreDrops — changing their order would move
    // money for an unrelated anomaly.
    const priorDrops = [...priorStopsToday]
      .sort(
        (a, b) =>
          (stopPayInstant(a)?.getTime() ?? 0) - (stopPayInstant(b)?.getTime() ?? 0)
      )
      .map((s) => {
        const zone = dropZoneCode(s, s.consignee.zone_code);
        return { zoneCode: zone, zonePoints: dropZonePoints(s, pointsByZone.get(zone), zone) };
      });
    const zonesDeliveredEarlierToday = priorDrops.map((d) => d.zoneCode);
    const priorPointsToday = scoreDrops(priorDrops).reduce((a, b) => a + b, 0);
    const drops = group.stops.map((s) => {
      const zone = dropZoneCode(s, s.consignee.zone_code);
      return { zoneCode: zone, zonePoints: dropZonePoints(s, pointsByZone.get(zone), zone) };
    });
    // THE RATE-TIER ANCHOR — deliberately NOT `group.anchor`.
    //
    // `calculateDeliveryIncentive` picks peak vs off-peak ONCE for the whole
    // group from this instant, and which timestamp selects a whole-trip rate is
    // a FROZEN item (AGENTS.md). The confirmed rule is delivery-confirm time
    // (3 Jul), refined by R1 Q4 to the time back to UWC — an arrival at a stop
    // that was never delivered is neither, and `group.anchor` is a MINIMUM, so
    // letting an arrival in could only ever drag the tier EARLIER (off-peak →
    // peak) and systematically underpay. Worked case: failed Ipoh arrival
    // 17:45 + Kulim delivered 18:20 → anchoring on the arrival rates the whole
    // group weekday RM11 (RM77) instead of off-peak RM13 (RM91).
    //
    // So: the earliest REAL delivery confirm in the group sets the tier. Only
    // when a group contains no delivery at all (an all-failed trip — nothing to
    // re-rate, and the arrival is the only instant that exists) does it fall
    // back to the group anchor. Q11(a) authorises paying the failed stop; it
    // says nothing about re-rating the delivered ones.
    // INTERPLANT (A4, 29 Jul 2026): a separate scheme — flat 1 point for a
    // COMPLETED round trip, no deduction, no per-zone scoring. Keyed on the
    // ROUTE TYPE, not the truck: the workbook is explicit that lorries swap
    // between interplant and customer work, so the pay follows the job.
    //
    // "Round trip complete" = every stop on the trip delivered. Deliberately the
    // WHOLE trip, not this day-group: the unit Mr. Teh pays for is the round
    // trip, so a group that happens to hold only the outbound leg must not pay.
    const interplant = isInterplantRouteType(trip.route_type?.name)
      ? { roundTripComplete: undeliveredStopCount === 0 }
      : undefined;
    const rateAnchor =
      group.stops.reduce<Date | null>(
        (earliest, s) =>
          s.real_delivered_at && (!earliest || s.real_delivered_at < earliest)
            ? s.real_delivered_at
            : earliest,
        null
      ) ?? group.anchor;
    const incentive = calculateDeliveryIncentive({ rateDateTime: rateAnchor, drops, zonesDeliveredEarlierToday, priorPointsToday, publicHolidays, truck: truckRates, interplant });
    incentiveThisTrip += incentive.incentiveThisTrip;
    finalizedGroups.push({ stops: group.stops.map((s) => ({ id: s.id, zoneCode: dropZoneCode(s, s.consignee.zone_code) })), result: incentive });
  }
  incentiveThisTrip = Math.round(incentiveThisTrip * 100) / 100;

  // Write-once CAS (status in_progress + incentive_earned null +
  // open_exception_id null) — under the lock this is fully atomic.
  const breakdown = collectFinalizeBreakdown(finalizedGroups);
  const proposed = await proposeTripIncentiveOnce(tx, trip.id, incentiveThisTrip, breakdown);
  return proposed ? incentiveThisTrip : null;
}
