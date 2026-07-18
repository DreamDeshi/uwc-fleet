/**
 * INCENTIVE conformance — a broad, spec-derived sweep that pins the money the
 * engine pays across the whole fleet and every zone, both rate tiers, the
 * per-zone-per-day repeat rule, the once-per-day deduction, and the awkward
 * time boundaries (6pm straddle, midnight split, holidays).
 *
 * This complements the focused unit tests (incentive.test.ts, dayLedger, etc.)
 * by being exhaustive over the matrix and by asserting engine output against a
 * value DERIVED FROM THE SPEC (not a second hand-typed constant), so a rate or
 * point change in docs/uwc-spec.json moves the expectation with it. A handful of
 * WORKBOOK golden anchors (RM33 / RM44 / RM55) guard against the formula and the
 * engine drifting together.
 */
import { describe, it, expect } from "vitest";
import {
  calculateDeliveryIncentive,
  scoreDrops,
  scoreDropsDetailed,
  isOffPeak,
  groupStopsByDeliveryDay,
} from "../../src/services/incentiveEngine";
import {
  DISPATCHABLE,
  ZONES,
  ZONE_POINTS,
  incTruck,
  drop,
  simulateDriverDay,
  D,
  NO_HOLIDAYS,
} from "./fixtures";

const firstTrip = (zoneCode: string, date: Date, plate: string, holidays = NO_HOLIDAYS) =>
  calculateDeliveryIncentive({
    rateDateTime: date,
    drops: [drop(zoneCode)],
    zonesDeliveredEarlierToday: [],
    priorPointsToday: 0,
    publicHolidays: holidays,
    truck: incTruck(plate),
  });

describe("anchor-date sanity (so the whole suite's tier assumptions hold)", () => {
  it("Monday 10:00 MYT is weekday-peak, 19:00 and 02:00 are off-peak, Saturday is off-peak", () => {
    expect(isOffPeak(D.monday(10), NO_HOLIDAYS)).toBe(false); // peak band 08:00–17:59
    expect(isOffPeak(D.monday(19), NO_HOLIDAYS)).toBe(true); // after 18:00
    expect(isOffPeak(D.monday(2), NO_HOLIDAYS)).toBe(true); // before 08:00
    expect(isOffPeak(D.saturday(10), NO_HOLIDAYS)).toBe(true); // weekend
  });
});

describe("incentive matrix — every dispatchable truck × every zone × both tiers (first trip of day)", () => {
  for (const t of DISPATCHABLE) {
    for (const zone of ZONES) {
      const points = ZONE_POINTS[zone];
      // Expected pay is derived from the SPEC values, not re-typed: the day's
      // first drop earns max(points − deduction, 0) × the tier's rate.
      it(`${t.plate} → ${zone} (${points}pt) pays correctly at both tiers`, () => {
        // Peak (Monday 10:00): weekday rate.
        const peak = firstTrip(zone, D.monday(10), t.plate);
        expect(peak.isOffPeak).toBe(false);
        expect(peak.rateUsed).toBe(t.weekday);
        expect(peak.incentiveThisTrip).toBe(Math.max(points - t.deduction, 0) * t.weekday);

        // Off-peak (Monday 19:00): off-peak rate.
        const off = firstTrip(zone, D.monday(19), t.plate);
        expect(off.isOffPeak).toBe(true);
        expect(off.rateUsed).toBe(t.offpeak);
        expect(off.incentiveThisTrip).toBe(Math.max(points - t.deduction, 0) * t.offpeak);

        // Pay is never negative regardless of tier (deduction floors at 0).
        expect(peak.incentiveThisTrip).toBeGreaterThanOrEqual(0);
        expect(off.incentiveThisTrip).toBeGreaterThanOrEqual(0);
      });
    }
  }
});

describe("workbook golden anchors (guard formula+engine drifting together)", () => {
  it("PLX 2406 to Kulim = RM 11 × 3 = RM 33 PRE-deduction (the sheet's yellow-point illustration)", () => {
    // The workbook's "RM 11 X 3 = RM 33" ignores the daily deduction — it is the
    // raw points×rate illustration. scoreDrops × weekday rate reproduces it.
    const pts = scoreDrops([drop("K1")])[0]; // Kulim first drop = full 3
    expect(pts).toBe(3);
    expect(pts * incTruck("PLX 2406").entitled_claim_weekday).toBe(33);
  });

  it("PLX 2406 one Ipoh trip = (6 − 2) × 11 = RM 44 (WhatsApp 30 Jun / deduction anchor)", () => {
    expect(firstTrip("A2", D.monday(10), "PLX 2406").incentiveThisTrip).toBe(44);
  });

  it("PLX low-then-high day: P2 then Ipoh = RM 55, deduction carried to the day total (dayLedger anchor)", () => {
    // Trip 1 P2 (1pt) alone floors to 0 but the deduction is NOT lost; trip 2
    // Ipoh scores under the carried deduction → day total (7 − 2) × 11 = 55.
    const day = simulateDriverDay("PLX 2406", [["P2"], ["A2"]], D.monday(10));
    expect(day.perTrip[0].incentiveThisTrip).toBe(0);
    expect(day.perTrip[1].incentiveThisTrip).toBe(55);
    expect(day.total).toBe(55);
  });
});

describe("per-zone-per-day repeat rule (first full, later same-zone = flat 1)", () => {
  it("scoreDropsDetailed: first drop full points, repeat = 1, different zone = full", () => {
    const scored = scoreDropsDetailed([drop("A2"), drop("A2"), drop("P1")]);
    expect(scored.map((s) => s.points)).toEqual([6, 1, 3]);
    expect(scored.map((s) => s.wasRepeat)).toEqual([false, true, false]);
  });

  it("repeat fires across SEPARATE trips the same day (two Penang runs on PLX)", () => {
    const day = simulateDriverDay("PLX 2406", [["P1"], ["P1"]], D.monday(10));
    // Day points 3 + 1 = 4, minus deduction 2 = 2 → × RM11 = RM22 total.
    expect(day.dayPoints).toBe(4);
    expect(day.total).toBe(22);
    expect(day.perTrip[1].wasRepeat).toEqual([true]);
  });
});

describe("deduction is spent exactly once per driver-day, at the day total", () => {
  it("three trips: the deduction lands once (day points − deduction) × rate", () => {
    // PLX Ipoh(6) then Ipoh-repeat(1) then Penang(3): day points 10, −2 = 8 × 11 = 88.
    const day = simulateDriverDay("PLX 2406", [["A2"], ["A2"], ["P1"]], D.monday(10));
    expect(day.dayPoints).toBe(10);
    const totalDeductionApplied = day.perTrip.reduce((s, r) => s + r.deductionApplied, 0);
    expect(totalDeductionApplied).toBe(2); // once, never per-trip
    expect(day.total).toBe(88);
    expect(day.total).toBe((10 - 2) * 11);
  });
});

describe("time boundaries", () => {
  it("6pm STRADDLE: a trip whose drops fall 17:50 and 18:30 is ONE day-group rated at the FIRST drop's tier (peak)", () => {
    // NOTE: this pins the CURRENT behaviour. Whether a straddling trip should be
    // one tier (this) or per-drop is an OPEN client question (see uwc-spec.json
    // client_decisions). If Mr. Teh rules per-drop, this expectation changes.
    const stops = [
      { delivered_at: D.monday(17, 50) },
      { delivered_at: D.monday(18, 30) },
    ];
    const groups = groupStopsByDeliveryDay(stops, D.monday(18, 30));
    expect(groups).toHaveLength(1); // same MYT day
    expect(isOffPeak(groups[0].anchor, NO_HOLIDAYS)).toBe(false); // anchored to 17:50 → peak
  });

  it("MIDNIGHT split: drops at 23:30 Mon and 00:30 Tue become TWO day-groups, each attributed to its own MYT day", () => {
    const stops = [
      { delivered_at: D.monday(23, 30) },
      { delivered_at: D.tuesday(0, 30) },
    ];
    const groups = groupStopsByDeliveryDay(stops, D.tuesday(0, 30));
    expect(groups).toHaveLength(2);
    // Different MYT days → each scores against its OWN ledger + daily deduction.
    expect(groups[0].dayStart.getTime()).not.toBe(groups[1].dayStart.getTime());
    // Both land off-peak here (Mon 23:30 is after 18:00; Tue 00:30 is before 08:00);
    // the assertion under test is the SPLIT plus the small-hours off-peak pricing.
    expect(isOffPeak(groups[1].anchor, NO_HOLIDAYS)).toBe(true);
  });

  it("HOLIDAY: a weekday-peak time on a listed public holiday prices at the off-peak rate", () => {
    const holidays = new Set(["2026-07-20"]); // the Monday, now a holiday
    const res = firstTrip("A2", D.monday(10), "PLX 2406", holidays);
    expect(res.isOffPeak).toBe(true);
    expect(res.rateUsed).toBe(incTruck("PLX 2406").entitled_claim_offpeak); // RM13, not RM11
    expect(res.incentiveThisTrip).toBe((6 - 2) * 13);
  });
});

describe("payroll golden — a full weekday across three drivers", () => {
  // Hand-computed expected day totals (Monday, peak, spec rates):
  //   PLX (ded2, RM11): A2, A2-repeat, P1 → (6+1+3−2)×11 = 88
  //   PND (ded2, RM11): K2, K1          → (4+3−2)×11    = 55
  //   PRJ (ded3, RM10): P1, P3          → (3+3−3)×10    = 30
  const cases: Array<[string, string[][], number, number]> = [
    ["PLX 2406", [["A2"], ["A2"], ["P1"]], 10, 88],
    ["PND 1888", [["K2"], ["K1"]], 7, 55],
    ["PRJ 5292", [["P1"], ["P3"]], 6, 30],
  ];
  for (const [plate, trips, dayPoints, total] of cases) {
    it(`${plate}: ${trips.length} trips → ${dayPoints} pts → RM ${total}`, () => {
      const day = simulateDriverDay(plate, trips, D.monday(10));
      expect(day.dayPoints).toBe(dayPoints);
      expect(day.total).toBe(total);
    });
  }
});

describe("invariant sweep — must hold for every driver across many day shapes", () => {
  // A broad set of day shapes: single, repeats, multi-zone, mixed.
  const dayShapes: string[][][] = [
    [["A2"]],
    [["P2"]], // 1-point floor case
    [["A2"], ["A2"]], // repeat
    [["K2"], ["K1"], ["P1"]],
    [["A2"], ["P1"], ["A2"], ["P3"]], // interleaved repeat
    [["P1", "P2", "P3"]], // multi-drop single trip
    [["KL"], ["KL"]], // furthest zone + repeat
  ];
  for (const t of DISPATCHABLE) {
    for (const tier of [D.monday(10), D.monday(19)] as const) {
      for (const shape of dayShapes) {
        it(`${t.plate} @ ${isOffPeak(tier, NO_HOLIDAYS) ? "off-peak" : "peak"} — ${JSON.stringify(shape)} holds all invariants`, () => {
          const day = simulateDriverDay(t.plate, shape, tier);
          // 1. No trip ever pays negative.
          for (const r of day.perTrip) expect(r.incentiveThisTrip).toBeGreaterThanOrEqual(0);
          // 2. Deduction spent at most once across the day (sum of applied == min(dayPoints, deduction)).
          const applied = day.perTrip.reduce((s, r) => s + r.deductionApplied, 0);
          expect(applied).toBe(Math.min(day.dayPoints, t.deduction));
          // 3. Day total equals the day-total formula exactly.
          const rate = isOffPeak(tier, NO_HOLIDAYS) ? t.offpeak : t.weekday;
          expect(day.total).toBe(Math.max(day.dayPoints - t.deduction, 0) * rate);
          // 4. Every trip's rateUsed matches the tier.
          for (const r of day.perTrip) {
            expect(r.rateUsed).toBe(rate);
            expect(r.isOffPeak).toBe(isOffPeak(tier, NO_HOLIDAYS));
          }
        });
      }
    }
  }
});
