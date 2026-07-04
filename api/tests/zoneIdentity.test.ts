import { describe, expect, it } from "vitest";
import {
  dropZoneCode,
  dropZonePoints,
  snapshotStopZonePoints,
} from "../src/services/rateSnapshot";
import { calculateDeliveryIncentive, scoreDropsDetailed } from "../src/services/incentiveEngine";
import { collectFinalizeBreakdown } from "../src/services/tripCompletion";

/**
 * Zone IDENTITY lock (audit 2026-07-05 #4, MONEY EVIDENCE).
 *
 * Points were already snapshotted at assignment, but the zone identity — the
 * day-ledger key and the persisted zone_code evidence — was read from the
 * consignee's LIVE zone at finalization. An admin zone correction (the whole
 * point of PATCH /consignees/:id) landing while a trip was in flight made the
 * evidence read the wrong zone ("K1 — 6 pts" when K1 is 3) and misclassified
 * same-day repeats. zone_code is now snapshotted at assignment right next to
 * zone_points and preferred everywhere finalization derives zone identity, so
 * a correction affects FUTURE bookings only.
 */

// PLX 2406 (weekday RM11 / off-peak RM13 / deduction 2) — the RM44 anchor truck.
const PLX = { daily_deduction_points: 2, entitled_claim_weekday: 11, entitled_claim_offpeak: 13 };
// Wed 2026-07-08 10:00 MYT (02:00 UTC) — plain weekday, no holiday.
const WEEKDAY = new Date("2026-07-08T02:00:00Z");
const NO_HOLIDAYS: ReadonlySet<string> = new Set();

// In-memory slice of the tx snapshotStopZonePoints touches, recording writes.
function makeTx(
  stops: { id: string; consignee: { zone_code: string } }[],
  rates: { zone_code: string; location_name: string; points: number }[]
) {
  const writes: Record<string, { zone_points: number; zone_code: string }> = {};
  const tx = {
    tripStop: {
      findMany: async () => stops,
      update: async (args: { where: { id: string }; data: { zone_points: number; zone_code: string } }) => {
        writes[args.where.id] = args.data;
      },
    },
    destinationRate: {
      findMany: async () =>
        rates.map((r) => ({ ...r, pending_points: null, pending_points_effective: null })),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { tx: tx as any, writes };
}

describe("assignment snapshots the zone identity next to the points", () => {
  it("writes zone_points AND zone_code from the consignee's zone at assignment time", async () => {
    const { tx, writes } = makeTx(
      [
        { id: "s1", consignee: { zone_code: "A2" } },
        { id: "s2", consignee: { zone_code: "K1" } },
      ],
      [
        { zone_code: "A2", location_name: "Ipoh", points: 6 },
        { zone_code: "K1", location_name: "Kulim", points: 3 },
      ]
    );
    await snapshotStopZonePoints(tx, "t1");
    expect(writes["s1"]).toEqual({ zone_points: 6, zone_code: "A2" });
    expect(writes["s2"]).toEqual({ zone_points: 3, zone_code: "K1" });
  });
});

describe("dropZoneCode — the identity finalization scores under", () => {
  it("prefers the assignment snapshot over the consignee's live zone", () => {
    expect(dropZoneCode({ zone_code: "A2" }, "K1")).toBe("A2");
  });

  it("falls back to the live zone for legacy stops assigned before the snapshot (NULL-safe)", () => {
    expect(dropZoneCode({ zone_code: null }, "A2")).toBe("A2");
  });
});

describe("mid-flight consignee zone correction (A2 → K1) — evidence stays with the pay", () => {
  // Assigned while the consignee read A2 (6 pts): both snapshots written.
  const stop = { id: "s1", zone_points: 6, zone_code: "A2" };
  // Admin has since corrected the consignee to K1 — the LIVE state at finalize.
  const liveConsigneeZone = "K1";
  const livePoints = new Map([
    ["A2", 6],
    ["K1", 3],
  ]);

  it("scores the drop under the ASSIGNMENT zone at the snapshotted points — RM44 anchor intact", () => {
    const zone = dropZoneCode(stop, liveConsigneeZone);
    expect(zone).toBe("A2"); // not K1
    const points = dropZonePoints(stop, livePoints.get(zone), zone);
    expect(points).toBe(6); // not K1's 3

    const result = calculateDeliveryIncentive({
      rateDateTime: WEEKDAY,
      drops: [{ zoneCode: zone, zonePoints: points }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    // (6 − 2) × 11 — the correction changed nothing about this trip's pay.
    expect(result.incentiveThisTrip).toBe(44);
  });

  it("persists evidence that matches: zone A2 with 6 points, never K1 with 6", () => {
    const zone = dropZoneCode(stop, liveConsigneeZone);
    const result = calculateDeliveryIncentive({
      rateDateTime: WEEKDAY,
      drops: [{ zoneCode: zone, zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    const breakdown = collectFinalizeBreakdown([
      { stops: [{ id: stop.id, zoneCode: zone }], result },
    ]);
    expect(breakdown.stopRows[0]).toEqual({
      id: "s1",
      points_awarded: 6,
      was_repeat: false,
      zone_code: "A2",
    });
  });

  it("keys the day ledger on the zone the prior drop was PAID under, not its consignee's corrected zone", () => {
    // The corrected consignee's earlier drop sits on the ledger as A2 (its
    // snapshot), so a later A2 drop today is a repeat (flat 1)...
    const ledgerZone = dropZoneCode({ zone_code: "A2" }, liveConsigneeZone);
    const repeat = scoreDropsDetailed([{ zoneCode: "A2", zonePoints: 6 }], [ledgerZone]);
    expect(repeat[0]).toEqual({ points: 1, wasRepeat: true });
    // ...while a first K1 drop is NOT demoted by the correction: full points.
    const k1First = scoreDropsDetailed([{ zoneCode: "K1", zonePoints: 3 }], [ledgerZone]);
    expect(k1First[0]).toEqual({ points: 3, wasRepeat: false });
  });

  it("a NEW booking after the correction snapshots the corrected zone (the feature's purpose)", async () => {
    const { tx, writes } = makeTx(
      [{ id: "s9", consignee: { zone_code: "K1" } }], // corrected consignee, fresh booking
      [{ zone_code: "K1", location_name: "Kulim", points: 3 }]
    );
    await snapshotStopZonePoints(tx, "t2");
    expect(writes["s9"]).toEqual({ zone_points: 3, zone_code: "K1" });
  });

  it("legacy stop with neither snapshot still scores at the live zone (pre-change behaviour)", () => {
    const legacy = { zone_points: null, zone_code: null };
    const zone = dropZoneCode(legacy, "A2");
    expect(zone).toBe("A2");
    expect(dropZonePoints(legacy, livePoints.get(zone), zone)).toBe(6);
  });
});
