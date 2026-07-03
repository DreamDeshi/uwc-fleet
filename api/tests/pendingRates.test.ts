import { describe, it, expect } from "vitest";
import {
  nextMytDayKey,
  pendingMatured,
  effectiveTruckRates,
  effectiveZonePoints,
  applyMaturedPendingRates,
  type RateMaturationClient,
} from "../src/services/pendingRates";
import {
  truckRateSnapshot,
  finalizationRateParams,
  dropZonePoints,
} from "../src/services/rateSnapshot";
import { calculateDeliveryIncentive } from "../src/services/incentiveEngine";

// Next-day rate cutoff (client rule, Mr. Teh 3 Jul 2026): a rate edit takes
// effect from the NEXT MYT day — today's assignments snapshot today's rates.

// PLX 2406 as it stands (the RM44 anchor truck)…
const BASE = {
  entitled_claim_weekday: 11,
  entitled_claim_offpeak: 13,
  daily_deduction_points: 2,
};
// …with a rate edit staged today (Fri 2026-07-03 MYT), effective tomorrow.
const WITH_PENDING = {
  ...BASE,
  pending_claim_weekday: 12,
  pending_claim_offpeak: 14,
  pending_deduction_points: 3,
  pending_rates_effective: "2026-07-04",
};

const editDayNoon = new Date("2026-07-03T04:00:00Z"); // Fri 2026-07-03 12:00 MYT
const justAfterMidnight = new Date("2026-07-03T16:30:00Z"); // Sat 2026-07-04 00:30 MYT
const nextDayNoon = new Date("2026-07-04T04:00:00Z"); // Sat 2026-07-04 12:00 MYT

const NO_HOLIDAYS: ReadonlySet<string> = new Set();

describe("nextMytDayKey — the earliest day an edit may take effect", () => {
  it("is the MYT day after the edit instant", () => {
    expect(nextMytDayKey(editDayNoon)).toBe("2026-07-04");
  });

  it("uses the MYT calendar, not UTC: 17:00 UTC is already tomorrow in MYT", () => {
    // 2026-07-03 17:00 UTC = 2026-07-04 01:00 MYT → "tomorrow" is the 5th.
    expect(nextMytDayKey(new Date("2026-07-03T17:00:00Z"))).toBe("2026-07-05");
  });

  it("rolls over month boundaries", () => {
    expect(nextMytDayKey(new Date("2026-07-31T04:00:00Z"))).toBe("2026-08-01");
  });
});

describe("effectiveTruckRates — the assignment-time rate merge", () => {
  it("CLIENT CASE: an edit made today is INVISIBLE to today's assignments (old rate)", () => {
    const eff = effectiveTruckRates(WITH_PENDING, editDayNoon);
    expect(Number(eff.entitled_claim_weekday)).toBe(11);
    expect(Number(eff.entitled_claim_offpeak)).toBe(13);
    expect(eff.daily_deduction_points).toBe(2);
  });

  it("CLIENT CASE: an assignment on the effective day gets the NEW rate", () => {
    const eff = effectiveTruckRates(WITH_PENDING, nextDayNoon);
    expect(Number(eff.entitled_claim_weekday)).toBe(12);
    expect(Number(eff.entitled_claim_offpeak)).toBe(14);
    expect(eff.daily_deduction_points).toBe(3);
  });

  it("the cutoff is midnight MYT sharp: 00:30 on the effective day already pays new", () => {
    expect(pendingMatured(WITH_PENDING, editDayNoon)).toBe(false);
    expect(pendingMatured(WITH_PENDING, justAfterMidnight)).toBe(true);
    const eff = effectiveTruckRates(WITH_PENDING, justAfterMidnight);
    expect(Number(eff.entitled_claim_weekday)).toBe(12);
  });

  it("a partial edit keeps unchanged fields at their base values", () => {
    const partial = {
      ...BASE,
      pending_claim_weekday: 12,
      pending_claim_offpeak: null,
      pending_deduction_points: null,
      pending_rates_effective: "2026-07-04",
    };
    const eff = effectiveTruckRates(partial, nextDayNoon);
    expect(Number(eff.entitled_claim_weekday)).toBe(12); // edited
    expect(Number(eff.entitled_claim_offpeak)).toBe(13); // untouched
    expect(eff.daily_deduction_points).toBe(2); // untouched
  });

  it("no staged edit → the base rates, any day", () => {
    const eff = effectiveTruckRates(BASE, nextDayNoon);
    expect(Number(eff.entitled_claim_weekday)).toBe(11);
  });
});

describe("end-to-end: cutoff + rate lock through the engine (money path)", () => {
  // Weekday Ipoh (A2 = 6 pts), first drop of the day — the RM44 anchor shape.
  const drops = [{ zoneCode: "A2", zonePoints: 6 }];
  const anchorArgs = {
    publicHolidays: NO_HOLIDAYS,
    drops,
    zonesDeliveredEarlierToday: [] as string[],
    isFirstDeliveredDropOfDay: true,
  };

  it("a trip ASSIGNED today (edit staged today) snapshots and pays the OLD rate: RM44", () => {
    // Assignment today: the snapshot freezes the rates effective NOW.
    const snapshot = truckRateSnapshot(effectiveTruckRates(WITH_PENDING, editDayNoon));
    const r = calculateDeliveryIncentive({
      ...anchorArgs,
      rateDateTime: editDayNoon,
      truck: finalizationRateParams({ ...snapshot, truck: WITH_PENDING }),
    });
    expect(r.incentiveThisTrip).toBe(44); // (6−2)×11 — the anchor, cutoff respected
  });

  it("a trip assigned today keeps RM44 even when it FINALIZES after the cutoff (running trip unaffected)", () => {
    // Assigned today at the old rates, delivered tomorrow when the new rates
    // are live: the snapshot rules — the staged (now matured) edit must not
    // leak into an in-flight trip's pay.
    const snapshot = truckRateSnapshot(effectiveTruckRates(WITH_PENDING, editDayNoon));
    const r = calculateDeliveryIncentive({
      ...anchorArgs,
      rateDateTime: nextDayNoon, // finalization moment (Saturday → off-peak tier of the SNAPSHOT)
      truck: finalizationRateParams({ ...snapshot, truck: WITH_PENDING }),
    });
    // Saturday delivery pays the snapshot's OFF-PEAK rate 13, not pending 14.
    expect(r.rateUsed).toBe(13);
    expect(r.incentiveThisTrip).toBe(52); // (6−2)×13
  });

  it("a trip ASSIGNED on/after the effective day snapshots the NEW rate", () => {
    const snapshot = truckRateSnapshot(effectiveTruckRates(WITH_PENDING, nextDayNoon));
    const r = calculateDeliveryIncentive({
      ...anchorArgs,
      rateDateTime: nextDayNoon, // Saturday → off-peak tier
      truck: finalizationRateParams({ ...snapshot, truck: WITH_PENDING }),
    });
    expect(r.rateUsed).toBe(14); // the NEW off-peak rate
    expect(r.incentiveThisTrip).toBe(42); // (6−3)×14
  });
});

// ── Zone points — the SAME cutoff, extended for consistency (both are pay inputs) ──

// A2 Ipoh at its live 6 points, with an edit to 7 staged today (eff. tomorrow).
const A2_WITH_PENDING = {
  points: 6,
  pending_points: 7,
  pending_points_effective: "2026-07-04",
};

describe("effectiveZonePoints — the assignment-time points merge", () => {
  it("CLIENT RULE: a points edit made today is INVISIBLE to today's assignments (old points)", () => {
    expect(effectiveZonePoints(A2_WITH_PENDING, editDayNoon)).toBe(6);
  });

  it("an assignment on the effective day gets the NEW points", () => {
    expect(effectiveZonePoints(A2_WITH_PENDING, nextDayNoon)).toBe(7);
    expect(effectiveZonePoints(A2_WITH_PENDING, justAfterMidnight)).toBe(7); // midnight MYT sharp
  });

  it("no staged edit → the live points, any day", () => {
    expect(effectiveZonePoints({ points: 6, pending_points: null, pending_points_effective: null }, nextDayNoon)).toBe(6);
    expect(effectiveZonePoints({ points: 6 }, nextDayNoon)).toBe(6); // fields absent entirely
  });

  it("RM44 ANCHOR: A2 staged 6→7 today — today's snapshot still pays (6−2)×11 = RM44", () => {
    const snapshotPoints = effectiveZonePoints(A2_WITH_PENDING, editDayNoon);
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: editDayNoon,
      drops: [{ zoneCode: "A2", zonePoints: snapshotPoints }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: BASE,
    });
    expect(r.incentiveThisTrip).toBe(44); // the anchor, cutoff respected
  });

  it("an assignment TOMORROW snapshots the new points: (7−2)×11 = RM55", () => {
    const snapshotPoints = effectiveZonePoints(A2_WITH_PENDING, nextDayNoon);
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: editDayNoon, // weekday tier — isolating the points change
      drops: [{ zoneCode: "A2", zonePoints: snapshotPoints }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: BASE,
    });
    expect(r.incentiveThisTrip).toBe(55);
  });

  it("a running/assigned trip keeps its STOP snapshot — the staged edit never leaks in", () => {
    // The stop was snapshotted at 6 points at assignment; even after the edit
    // matures (live 7), finalization reads the snapshot (rate lock).
    expect(dropZonePoints({ zone_points: 6 }, effectiveZonePoints({ ...A2_WITH_PENDING, points: 7 }, nextDayNoon), "A2")).toBe(6);
  });
});

describe("applyMaturedPendingRates — the maturation sweep (trucks + zone points)", () => {
  // In-memory stand-in for the Prisma slices: honours the lte filters the
  // sweep uses, and records updates.
  function fakeClient(
    truckRows: (typeof WITH_PENDING & { plate: string })[],
    pointRows: ({ id: string } & typeof A2_WITH_PENDING)[] = []
  ) {
    const truckUpdates: { plate: string; data: Record<string, unknown> }[] = [];
    const pointUpdates: { id: string; data: Record<string, unknown> }[] = [];
    const client: RateMaturationClient = {
      truck: {
        async findMany(args) {
          const lte = args.where.pending_rates_effective.lte;
          return truckRows.filter(
            (r) => r.pending_rates_effective !== null && r.pending_rates_effective <= lte
          );
        },
        async update(args) {
          truckUpdates.push({ plate: args.where.plate, data: args.data });
          return {};
        },
      },
      destinationRate: {
        async findMany(args) {
          const lte = args.where.pending_points_effective.lte;
          return pointRows.filter(
            (r) => r.pending_points_effective !== null && r.pending_points_effective <= lte
          );
        },
        async update(args) {
          pointUpdates.push({ id: args.where.id, data: args.data });
          return {};
        },
      },
    };
    return { client, truckUpdates, pointUpdates };
  }

  it("folds a matured pending edit into the base columns and clears the staging fields", async () => {
    const { client, truckUpdates } = fakeClient([{ ...WITH_PENDING, plate: "PLX 2406" }]);
    const folded = await applyMaturedPendingRates(client, nextDayNoon);
    expect(folded).toEqual(["PLX 2406"]);
    expect(truckUpdates).toHaveLength(1);
    expect(truckUpdates[0].data).toMatchObject({
      entitled_claim_weekday: 12,
      entitled_claim_offpeak: 14,
      daily_deduction_points: 3,
      pending_claim_weekday: null,
      pending_claim_offpeak: null,
      pending_deduction_points: null,
      pending_rates_effective: null,
    });
  });

  it("leaves a not-yet-matured edit alone (sweep runs on the edit day)", async () => {
    const { client, truckUpdates, pointUpdates } = fakeClient(
      [{ ...WITH_PENDING, plate: "PLX 2406" }],
      [{ id: "dr-a2", ...A2_WITH_PENDING }]
    );
    const folded = await applyMaturedPendingRates(client, editDayNoon);
    expect(folded).toEqual([]);
    expect(truckUpdates).toHaveLength(0);
    expect(pointUpdates).toHaveLength(0);
  });

  it("folds matured ZONE-POINTS edits too, clearing their staging fields", async () => {
    const { client, pointUpdates } = fakeClient([], [{ id: "dr-a2", ...A2_WITH_PENDING }]);
    const folded = await applyMaturedPendingRates(client, nextDayNoon);
    expect(folded).toEqual(["zone-points:dr-a2"]);
    expect(pointUpdates).toHaveLength(1);
    expect(pointUpdates[0].data).toEqual({
      points: 7,
      pending_points: null,
      pending_points_effective: null,
    });
  });
});
