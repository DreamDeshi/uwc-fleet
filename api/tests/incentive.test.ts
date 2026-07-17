import { describe, it, expect } from "vitest";
import {
  isOffPeak,
  scoreDrops,
  scoreDropsDetailed,
  isDocumentationComplete,
  calculateDeliveryIncentive,
  getTripDayStart,
  getTripDayEnd,
  groupStopsByDeliveryDay,
  mytDateKey,
} from "../src/services/incentiveEngine";

// The primary A1/A2 truck (PLX 2406): weekday RM11, off-peak RM13, deduction 2 pts.
const PLX2406 = { daily_deduction_points: 2, entitled_claim_weekday: 11, entitled_claim_offpeak: 13 };
// The 1t truck (PRH 5292): flat RM9, seeded deduction 2 pts.
const PRH5292 = { daily_deduction_points: 2, entitled_claim_weekday: 9, entitled_claim_offpeak: 9 };
// A 17.5ft lorry class: flat RM10, deduction 3 pts.
const TRUCK_17_5 = { daily_deduction_points: 3, entitled_claim_weekday: 10, entitled_claim_offpeak: 10 };

// Zone points used in the examples: A2 Ipoh = 6, A1 Taiping = 5, K2 = 4,
// K1 Kulim = 3, P1 Penang = 3, P2 Juru/Perai = 1.

// All dates below are written as explicit UTC instants (…Z); the comment gives
// the Malaysia-time (UTC+8) wall clock the engine actually evaluates against.
// Since the client's 3 Jul 2026 day-boundary answer these instants are the
// DELIVERY-CONFIRM anchor (rateDateTime) — points and the rate tier key on
// when a drop is confirmed delivered, not on the pickup time.
const weekdayMorning = new Date("2026-06-22T01:00:00Z"); // Monday 9am MYT (weekday/peak)
const offpeakEvening = new Date("2026-06-22T11:00:00Z"); // Monday 7pm MYT (off-peak, after 6pm)

// The engine holds NO baked-in holiday list — the calendar is caller-supplied
// (loaded from the admin-managed PublicHoliday table at the route layer).
const NO_HOLIDAYS: ReadonlySet<string> = new Set();

describe("isOffPeak — evaluated in Malaysia time (UTC+8)", () => {
  it("treats Mon-Fri before 6pm MYT as weekday", () => {
    expect(isOffPeak(new Date("2026-06-24T03:00:00Z"), NO_HOLIDAYS)).toBe(false); // Wed 11am MYT
  });

  it("treats Mon-Fri at/after 6pm MYT as off-peak", () => {
    expect(isOffPeak(new Date("2026-06-24T10:30:00Z"), NO_HOLIDAYS)).toBe(true); // Wed 6:30pm MYT
    expect(isOffPeak(new Date("2026-06-24T15:00:00Z"), NO_HOLIDAYS)).toBe(true); // Wed 11pm MYT
  });

  it("treats Saturday and Sunday (MYT) as off-peak regardless of time", () => {
    expect(isOffPeak(new Date("2026-06-20T01:00:00Z"), NO_HOLIDAYS)).toBe(true); // Sat 9am MYT
    expect(isOffPeak(new Date("2026-06-21T01:00:00Z"), NO_HOLIDAYS)).toBe(true); // Sun 9am MYT
  });

  it("uses MYT not server UTC: 10:30 UTC on a weekday is 6:30pm MYT → off-peak", () => {
    expect(isOffPeak(new Date("2026-06-24T10:30:00Z"), NO_HOLIDAYS)).toBe(true);
  });
});

describe("isOffPeak — the caller-supplied holiday calendar drives off-peak", () => {
  // 2026-05-01 (Labour Day) is a Friday; noon MYT = 04:00 UTC.
  const labourDayNoon = new Date("2026-05-01T04:00:00Z");

  it("treats a weekday in the holiday set as off-peak all day", () => {
    expect(isOffPeak(labourDayNoon, new Set(["2026-05-01"]))).toBe(true);
  });

  it("the SAME date without the calendar entry is a normal weekday (no baked-in list)", () => {
    expect(isOffPeak(labourDayNoon, NO_HOLIDAYS)).toBe(false);
  });

  it("a normal weekday is unaffected by other dates in the calendar", () => {
    expect(isOffPeak(new Date("2026-06-24T04:00:00Z"), new Set(["2026-05-01"]))).toBe(false); // Wed noon MYT
  });

  it("matches on the MYT calendar day, not the UTC day", () => {
    const holiday = new Set(["2026-06-24"]); // a Wednesday
    // Inside the 08:00–17:59 peak band the calendar is the ONLY thing that can
    // flip the tier, so that band is where the holiday lookup is observable.
    // 2026-06-24 01:00 UTC = Wed 2026-06-24 09:00 MYT → the holiday → off-peak.
    expect(isOffPeak(new Date("2026-06-24T01:00:00Z"), holiday)).toBe(true);
    // 2026-06-25 01:00 UTC = Thu 2026-06-25 09:00 MYT → not the holiday → peak.
    expect(isOffPeak(new Date("2026-06-25T01:00:00Z"), holiday)).toBe(false);
  });

  it("keys the holiday calendar on the MYT calendar day, not the UTC day", () => {
    // ⚠ This assertion used to live in the test above, on instants at 01:00 MYT
    // (the only hours where the UTC and MYT dates diverge are 00:00–07:59 MYT,
    // i.e. 16:00–23:59 UTC the day before). Since 2026-07-17 that whole band is
    // off-peak BY HOUR, so isOffPeak() can no longer distinguish a MYT-keyed
    // lookup from a UTC-keyed one there — it returns true either way. The
    // MYT-day keying is still load-bearing (getTripDayStart and the ledger
    // window depend on it), so it is pinned directly on mytDateKey instead of
    // being silently dropped.
    // 2026-06-23 17:00 UTC = Wed 2026-06-24 01:00 MYT — MYT date is the 24th…
    expect(mytDateKey(new Date("2026-06-23T17:00:00Z"))).toBe("2026-06-24");
    // …and 2026-06-24 17:00 UTC = Thu 2026-06-25 01:00 MYT — the 25th, not the
    // 24th (a UTC-keyed implementation would wrongly say the 24th here).
    expect(mytDateKey(new Date("2026-06-24T17:00:00Z"))).toBe("2026-06-25");
  });
});

describe("getTripDayStart / getTripDayEnd — trip-day binning in MYT (Fix 2)", () => {
  it("bins 00:30 and 23:30 of the same MYT day into the same trip-day", () => {
    const early = new Date("2026-06-21T16:30:00Z"); // 2026-06-22 00:30 MYT
    const late = new Date("2026-06-22T15:30:00Z"); // 2026-06-22 23:30 MYT
    expect(getTripDayStart(early).getTime()).toBe(getTripDayStart(late).getTime());
  });

  it("puts 23:30 MYT and 00:30 MYT the next day into different trip-days", () => {
    const lateNight = new Date("2026-06-22T15:30:00Z"); // 2026-06-22 23:30 MYT
    const afterMidnight = new Date("2026-06-22T16:30:00Z"); // 2026-06-23 00:30 MYT
    expect(getTripDayStart(lateNight).getTime()).not.toBe(getTripDayStart(afterMidnight).getTime());
  });

  it("returns midnight MYT (16:00 UTC previous day) as the start, end = +24h", () => {
    const t = new Date("2026-06-22T15:30:00Z"); // 2026-06-22 23:30 MYT
    const start = getTripDayStart(t);
    expect(start.toISOString()).toBe("2026-06-21T16:00:00.000Z"); // 2026-06-22 00:00 MYT
    expect(getTripDayEnd(t).getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("scoreDrops — per-zone-per-day-per-driver points (client-confirmed)", () => {
  it("a single drop into a fresh zone earns that zone's full points", () => {
    expect(scoreDrops([{ zoneCode: "A2", zonePoints: 6 }])).toEqual([6]);
  });

  it("a repeat drop into the same zone the same day earns 1 point (counter: 3 then 1 = 4)", () => {
    const pts = scoreDrops([
      { zoneCode: "K1", zonePoints: 3 },
      { zoneCode: "K1", zonePoints: 3 },
    ]);
    expect(pts).toEqual([3, 1]);
    expect(pts.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("three drops into three different zones each earn full points: 6+3+3 = 12", () => {
    const pts = scoreDrops([
      { zoneCode: "A2", zonePoints: 6 }, // Ipoh
      { zoneCode: "K1", zonePoints: 3 }, // Kulim
      { zoneCode: "P1", zonePoints: 3 }, // Penang
    ]);
    expect(pts).toEqual([6, 3, 3]);
    expect(pts.reduce((a, b) => a + b, 0)).toBe(12);
  });

  it("scores a stop 1pt when its zone was already hit earlier today (across trips)", () => {
    // Kulim already delivered earlier today → this Kulim drop is a repeat.
    expect(scoreDrops([{ zoneCode: "K1", zonePoints: 3 }], ["K1"])).toEqual([1]);
  });

  it("scores a multi-stop trip with a repeated own zone: first full, repeat 1pt", () => {
    expect(
      scoreDrops([
        { zoneCode: "K1", zonePoints: 3 },
        { zoneCode: "A2", zonePoints: 6 },
        { zoneCode: "K1", zonePoints: 3 },
      ])
    ).toEqual([3, 6, 1]);
  });
});

describe("isDocumentationComplete — the documentation gate", () => {
  const POD = "https://res.cloudinary.com/demo/pod.jpg";

  it("blocks when the DO photo is missing", () => {
    expect(
      isDocumentationComplete({ do_uploaded: false, k2_form_ack: true, pod_photo: null }, "P1")
    ).toBe(false);
  });

  it("blocks when do_uploaded is set but no POD photo exists (self-attested flag)", () => {
    expect(
      isDocumentationComplete({ do_uploaded: true, k2_form_ack: true, pod_photo: null }, "P1")
    ).toBe(false);
  });

  it("passes for non-K2 zones once the POD photo is uploaded", () => {
    expect(
      isDocumentationComplete({ do_uploaded: true, k2_form_ack: false, pod_photo: POD }, "P1")
    ).toBe(true);
  });

  it("requires the K2 form ack only when destination zone is K2", () => {
    expect(
      isDocumentationComplete({ do_uploaded: true, k2_form_ack: false, pod_photo: POD }, "K2")
    ).toBe(false);
    expect(
      isDocumentationComplete({ do_uploaded: true, k2_form_ack: true, pod_photo: POD }, "K2")
    ).toBe(true);
  });
});

describe("calculateDeliveryIncentive — single-stop trips", () => {
  it("CONFIRMED ANCHOR: PLX 2406, single Ipoh (A2) weekday → (6−2)×11 = RM44", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    expect(r.isOffPeak).toBe(false);
    expect(r.rateUsed).toBe(11);
    expect(r.dropPoints).toEqual([6]);
    expect(r.deductionApplied).toBe(2);
    expect(r.incentiveThisTrip).toBe(44);
  });

  it("REGRESSION: PLX 2406, single Kulim (K1) off-peak → (3−2)×13 = RM13", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: offpeakEvening,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    expect(r.isOffPeak).toBe(true);
    expect(r.rateUsed).toBe(13);
    expect(r.incentiveThisTrip).toBe(13);
  });

  it("REGRESSION: PRH 5292, single Ipoh (A2) off-peak → (6−2)×9 = RM36 (seeded PRH deduction 2)", () => {
    expect(PRH5292.daily_deduction_points).toBe(2); // flag if the seeded value ever changes
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: offpeakEvening,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PRH5292,
    });
    expect(r.rateUsed).toBe(9);
    expect(r.incentiveThisTrip).toBe(36);
  });

  it("applies each truck's own deduction (17.5ft lorry: 3 pts) on a K2 first drop: (4−3)×10 = RM10", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "K2", zonePoints: 4 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: TRUCK_17_5,
    });
    expect(r.incentiveThisTrip).toBe(10);
  });

  it("a single-drop day worth less than the deduction pays RM0 (P2=1 − deduction 2, floored at the DAY total)", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "P2", zonePoints: 1 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first (and only) drop
      truck: PLX2406,
    });
    expect(r.incentiveThisTrip).toBe(0); // max(1 − 2, 0) × 11
    expect(r.deductionApplied).toBe(1); // the day's only point is absorbed; never negative pay
  });
});

describe("calculateDeliveryIncentive — multi-trip day (marginals sum, deduction once)", () => {
  // Ipoh(6) → Kulim(3) → Penang(3), three single-stop trips, PLX 2406 weekday.
  // Pre-deduction zone points = 6+3+3 = 12; deduction (2) applied once on trip 1.
  it("scores three different-zone trips and sums marginals to the day total", () => {
    const t1 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    const t2 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: ["A2"],
      priorPointsToday: 6, // A2 (6pts) delivered earlier today
      truck: PLX2406,
    });
    const t3 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "P1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: ["A2", "K1"],
      priorPointsToday: 9, // A2 (6) + K1 (3) delivered earlier today
      truck: PLX2406,
    });
    expect(t1.incentiveThisTrip).toBe(44); // (6−2)×11
    expect(t2.incentiveThisTrip).toBe(33); // 3×11, no deduction
    expect(t3.incentiveThisTrip).toBe(33); // 3×11, no deduction
    const dayTotal = t1.incentiveThisTrip + t2.incentiveThisTrip + t3.incentiveThisTrip;
    expect(dayTotal).toBe(110); // (12 − 2) × 11
  });

  it("two trips to the SAME zone: second trip's drop scores 1pt (deduction only on the first)", () => {
    const t1 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    const t2 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: ["K1"],
      priorPointsToday: 3, // K1 (3pts) delivered earlier today
      truck: PLX2406,
    });
    expect(t1.incentiveThisTrip).toBe(11); // (3−2)×11
    expect(t2.dropPoints).toEqual([1]); // repeat zone
    expect(t2.incentiveThisTrip).toBe(11); // 1×11
  });
});

describe("calculateDeliveryIncentive — multi-stop scoring within one trip", () => {
  it("first stop in zone full, repeat-zone stop 1pt, deduction on the day's first stop", () => {
    // One trip, stops Kulim → Kulim, PLX 2406 weekday, first trip of the day.
    // dropPoints = [3, 1]; first drop deducted: (3−2)=1 → incentive = (1 + 1) × 11 = 22.
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [
        { zoneCode: "K1", zonePoints: 3 },
        { zoneCode: "K1", zonePoints: 3 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    expect(r.dropPoints).toEqual([3, 1]);
    expect(r.incentiveThisTrip).toBe(22);
  });

  it("a stop whose zone an EARLIER trip already hit scores 1pt; no deduction (not day's first)", () => {
    // Earlier trip already delivered to Kulim. This trip: Kulim → Ipoh.
    // Kulim repeat → 1; Ipoh fresh → 6. No deduction (day's first drop was earlier).
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [
        { zoneCode: "K1", zonePoints: 3 },
        { zoneCode: "A2", zonePoints: 6 },
      ],
      zonesDeliveredEarlierToday: ["K1"],
      priorPointsToday: 3, // K1 (3pts) delivered earlier today
      truck: PLX2406,
    });
    expect(r.dropPoints).toEqual([1, 6]);
    expect(r.deductionApplied).toBe(0);
    expect(r.incentiveThisTrip).toBe(77); // (1 + 6) × 11
  });
});

describe("calculateDeliveryIncentive — daily deduction folds into the DAY TOTAL (workbook rule)", () => {
  // Workbook (INTERNAL LORRY RATE, row 2): "accumulate TOTAL 20 trip incentive
  // point per day … calculate as 18 point (minus 2)" — the deduction comes off
  // the day's TOTAL points, floored at 0, NOT off the first drop. (2026-07-16:
  // this replaced the old first-drop-floored behaviour, which overpaid whenever
  // the day's first drop was worth fewer points than the deduction.)

  it("WORKBOOK EXAMPLE: a 20-point day minus the 2-pt deduction → 18 points ((20−2)×11 = RM198)", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [
        { zoneCode: "KL", zonePoints: 8 },
        { zoneCode: "A2", zonePoints: 6 },
        { zoneCode: "A1", zonePoints: 5 },
        { zoneCode: "P2", zonePoints: 1 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      truck: PLX2406,
    });
    expect(r.pointsThisTrip).toBe(20);
    expect(r.deductionApplied).toBe(2);
    expect(r.incentiveThisTrip).toBe(198); // (20 − 2) × 11
  });

  it("BUG FIX: a low-point FIRST drop no longer loses deduction — [P2 1, K1 3, P1 3] → (7−2)×11 = RM55, not RM66", () => {
    // Old code floored the first drop (1 − 2 → 0) and kept K1+P1 in full → RM66.
    // The workbook deducts from the day total: (1+3+3 − 2) × 11 = RM55.
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "K1", zonePoints: 3 },
        { zoneCode: "P1", zonePoints: 3 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      truck: PLX2406,
    });
    expect(r.dropPoints).toEqual([1, 3, 3]);
    expect(r.deductionApplied).toBe(2); // the FULL deduction, off the day total
    expect(r.incentiveThisTrip).toBe(55);
  });

  it("BUG FIX across trips: low-first-drop trip A then trip B — marginals telescope to (7−2)×11 = RM55", () => {
    // Trip A: single P2 (1pt), day's first. Trip B: K1(3)+P1(3), prior points = 1.
    // Old code: A=0, B=6×11=RM66 (no deduction on B). New: A=0, B=5×11=RM55.
    const a = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "P2", zonePoints: 1 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      truck: PLX2406,
    });
    const b = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [
        { zoneCode: "K1", zonePoints: 3 },
        { zoneCode: "P1", zonePoints: 3 },
      ],
      zonesDeliveredEarlierToday: ["P2"],
      priorPointsToday: 1, // trip A's P2 drop
      truck: PLX2406,
    });
    expect(a.incentiveThisTrip).toBe(0); // max(1−2,0) × 11
    expect(a.deductionApplied).toBe(1);
    expect(b.incentiveThisTrip).toBe(55); // (max(1+6−2,0) − max(1−2,0)) × 11 = 5×11
    expect(b.deductionApplied).toBe(1); // B absorbs the leftover 1 pt of deduction
    expect(a.incentiveThisTrip + b.incentiveThisTrip).toBe(55); // day total = (7 − 2) × 11
  });

  it("never negative: a whole day worth less than the deduction pays RM0 (deduction 10 vs 4 points)", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "K1", zonePoints: 3 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      truck: { ...PLX2406, daily_deduction_points: 10 },
    });
    expect(r.incentiveThisTrip).toBe(0);
    expect(r.incentiveThisTrip).toBeGreaterThanOrEqual(0);
    expect(r.deductionApplied).toBe(4); // only the 4 available points can be absorbed
  });

  it("midnight straddle: each MYT day folds its OWN deduction at its OWN day total (low first drop included)", () => {
    // Group 1 (Monday off-peak): P2(1) + A2(6) → (7−2)×13 = RM65 — the low P2
    // first drop does NOT lose the deduction. Group 2 (Tuesday 00:10): fresh
    // K1(3) with Tuesday's own deduction → (3−2)×13 = RM13.
    //
    // ⚠ CORRECTED 2026-07-17: group 2 previously expected the PEAK RM11, on the
    // comment "Tue 00:10 MYT — weekday". The workbook's peak table is headed
    // "Weekday 8am - 6pm", so 00:10 is outside it and prices off-peak. The DAY
    // (ledger + deduction) still resets at midnight per Mr. Teh's Q1 — that is
    // a separate boundary from the rate tier, which is why g2 keeps its own
    // fresh deduction while staying on the same off-peak rate as g1.
    const g1 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: new Date("2026-06-22T15:50:00Z"), // Mon 23:50 MYT — off-peak
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "A2", zonePoints: 6 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      truck: PLX2406,
    });
    const g2 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: new Date("2026-06-22T16:10:00Z"), // Tue 00:10 MYT — before 8am ⇒ off-peak
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [], // ledger refreshed at midnight
      priorPointsToday: 0,
      truck: PLX2406,
    });
    expect(g1.isOffPeak).toBe(true);
    expect(g1.incentiveThisTrip).toBe(65); // (1 + 6 − 2) × 13
    expect(g1.deductionApplied).toBe(2);
    expect(g2.isOffPeak).toBe(true); // 00:10 is outside "Weekday 8am - 6pm"
    expect(g2.incentiveThisTrip).toBe(13); // (3 − 2) × 13
    expect(g2.deductionApplied).toBe(2); // …but the DEDUCTION day still reset at midnight
  });
});

describe("calculateDeliveryIncentive — the admin holiday calendar drives the rate tier", () => {
  // weekdayMorning is Monday 9am MYT (2026-06-22). Same instant, two calendars.
  it("pays the off-peak rate when the delivery-confirm's MYT day is in the calendar", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: new Set(["2026-06-22"]),
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    expect(r.isOffPeak).toBe(true);
    expect(r.rateUsed).toBe(13);
    expect(r.incentiveThisTrip).toBe(52); // (6−2)×13
  });

  it("the same trip with an empty calendar pays the weekday rate (no baked-in list)", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    expect(r.rateUsed).toBe(11);
    expect(r.incentiveThisTrip).toBe(44); // the anchor, unaffected
  });
});

// ── Day attribution keys on DELIVERY confirm time (client rule, 3 Jul 2026) ──
// "Points calculate on delivery confirm time; after 12am points refresh for
// next day." The pickup time no longer plays any part in which day a drop
// counts for — groupStopsByDeliveryDay + the delivered_at-windowed ledger in
// trips.ts implement it; these tests pin the behaviour the client confirmed.
describe("delivery-day attribution — groupStopsByDeliveryDay", () => {
  const fallback = new Date("2026-06-23T04:00:00Z"); // finalization moment (unused when delivered_at set)

  it("CLIENT CASE: picked up 23:30, delivered 00:30 next day → counts for the DELIVERY day", () => {
    const pickup = new Date("2026-06-22T15:30:00Z"); // Mon 2026-06-22 23:30 MYT
    const deliveredAt = new Date("2026-06-22T16:30:00Z"); // Tue 2026-06-23 00:30 MYT
    const groups = groupStopsByDeliveryDay([{ delivered_at: deliveredAt }], fallback);

    expect(groups).toHaveLength(1);
    // The group's day is the DELIVERY day (Tue 2026-06-23 MYT)…
    expect(groups[0].dayStart.getTime()).toBe(getTripDayStart(deliveredAt).getTime());
    // …NOT the pickup day (Mon 2026-06-22 MYT).
    expect(groups[0].dayStart.getTime()).not.toBe(getTripDayStart(pickup).getTime());
    // And the rate anchor is the delivery confirm — Tue 00:30 MYT, which is
    // OUTSIDE the workbook's "Weekday 8am - 6pm" peak table and so pays the
    // OFF-PEAK tier, same as the 23:30 pickup that started the run.
    //
    // ⚠ CORRECTED 2026-07-17: this expected `false` (peak), justified as "Tue
    // 00:30 MYT is before 18:00" — reasoning off the cutoff's evening end only
    // and forgetting the peak table's own 8am start. It made a driver's pay
    // JUMP from off-peak to peak by crossing midnight mid-run, which is what
    // gave the bug away: the run never left the night.
    expect(isOffPeak(groups[0].anchor, NO_HOLIDAYS)).toBe(true);
  });

  it("a multi-stop trip delivered within one MYT day stays one group, in delivered order", () => {
    const s1 = { delivered_at: new Date("2026-06-22T03:00:00Z") }; // Mon 11:00 MYT
    const s2 = { delivered_at: new Date("2026-06-22T01:00:00Z") }; // Mon 09:00 MYT
    const groups = groupStopsByDeliveryDay([s1, s2], fallback);
    expect(groups).toHaveLength(1);
    expect(groups[0].stops).toEqual([s2, s1]); // sorted by delivered_at
    expect(groups[0].anchor.getTime()).toBe(s2.delivered_at.getTime()); // first confirm anchors the rate
  });

  it("a trip whose confirms straddle midnight splits into two day groups ('after 12am points refresh')", () => {
    const beforeMidnight = { delivered_at: new Date("2026-06-22T15:50:00Z") }; // Mon 23:50 MYT
    const afterMidnight = { delivered_at: new Date("2026-06-22T16:10:00Z") }; // Tue 00:10 MYT
    const groups = groupStopsByDeliveryDay([beforeMidnight, afterMidnight], fallback);

    expect(groups).toHaveLength(2);
    expect(groups[0].stops).toEqual([beforeMidnight]);
    expect(groups[1].stops).toEqual([afterMidnight]);
    expect(groups[1].dayStart.getTime()).toBe(groups[0].dayEnd.getTime()); // consecutive MYT days
  });

  it("a delivered stop missing delivered_at falls back to the finalization moment (defensive)", () => {
    const groups = groupStopsByDeliveryDay([{ delivered_at: null }], fallback);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayStart.getTime()).toBe(getTripDayStart(fallback).getTime());
  });
});

describe("delivery-day attribution — ledger and deduction follow the delivery day", () => {
  it("CLIENT CASE: two trips DELIVERED the same day but picked up on different days share one ledger day", () => {
    // Trip 1: picked up Sunday 23:00 MYT, its Kulim drop confirmed Monday 00:40 MYT.
    const trip1Delivered = new Date("2026-06-21T16:40:00Z"); // Mon 2026-06-22 00:40 MYT
    // Trip 2: picked up Monday 08:00 MYT, its Kulim drop confirmed Monday 10:00 MYT.
    const trip2Delivered = new Date("2026-06-22T02:00:00Z"); // Mon 2026-06-22 10:00 MYT

    // Different pickup days, but both DELIVERED on Monday MYT → same ledger day.
    expect(getTripDayStart(trip1Delivered).getTime()).toBe(getTripDayStart(trip2Delivered).getTime());

    // Trip 1 finalizes first: empty Monday ledger → full points + the deduction.
    const t1 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: trip1Delivered,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    // Trip 2's Monday ledger already holds trip 1's K1 drop (delivered Monday,
    // regardless of trip 1's Sunday pickup): repeat zone → 1pt, no deduction.
    const t2 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: trip2Delivered,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: ["K1"],
      priorPointsToday: 3, // K1 (3pts) delivered earlier today
      truck: PLX2406,
    });

    // The two trips share a LEDGER day but not a RATE tier — 00:40 is outside
    // the "Weekday 8am - 6pm" peak table (off-peak RM13), 10:00 is inside it
    // (peak RM11). That is the point: the midnight ledger reset and the
    // 08:00/18:00 rate band are independent boundaries, and this case is the
    // one that shows both at once.
    expect(t1.isOffPeak).toBe(true); // Mon 00:40 MYT — before 8am
    expect(t1.incentiveThisTrip).toBe(13); // (3−2)×13 — day's first drop takes the deduction
    expect(t2.isOffPeak).toBe(false); // Mon 10:00 MYT — inside the peak band
    expect(t2.dropPoints).toEqual([1]); // same-zone repeat ON THE DELIVERY DAY
    expect(t2.deductionApplied).toBe(0); // deduction once per day, already spent
    expect(t2.incentiveThisTrip).toBe(11); // 1×11
  });

  it("a midnight-straddling trip earns a fresh ledger AND a fresh deduction after 12am", () => {
    // One trip, two Kulim stops: 23:50 MYT Monday and 00:10 MYT Tuesday.
    const stops = [
      { delivered_at: new Date("2026-06-22T15:50:00Z"), zone: "K1" }, // Mon 23:50 MYT
      { delivered_at: new Date("2026-06-22T16:10:00Z"), zone: "K1" }, // Tue 00:10 MYT
    ];
    const groups = groupStopsByDeliveryDay(stops, new Date("2026-06-22T16:15:00Z"));
    expect(groups).toHaveLength(2);

    // Group 1 (Monday): first drop of ITS day → full points minus deduction.
    const g1 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: groups[0].anchor,
      drops: groups[0].stops.map((s) => ({ zoneCode: s.zone, zonePoints: 3 })),
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    // Group 2 (Tuesday): the ledger REFRESHED at midnight — K1 is a fresh zone
    // again (full 3 points) and Tuesday's deduction lands on this drop.
    const g2 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: groups[1].anchor,
      drops: groups[1].stops.map((s) => ({ zoneCode: s.zone, zonePoints: 3 })),
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });

    expect(g1.isOffPeak).toBe(true); // Mon 23:50 MYT — after 18:00
    expect(g1.incentiveThisTrip).toBe(13); // (3−2)×13
    expect(g2.dropPoints).toEqual([3]); // NOT a 1pt repeat — points refreshed
    expect(g2.deductionApplied).toBe(2); // Tuesday's own deduction
    // The LEDGER crossed into Tuesday, but the RATE did not change: 00:10 is
    // still outside "Weekday 8am - 6pm". One continuous night run, one rate.
    expect(g2.isOffPeak).toBe(true); // Tue 00:10 MYT — before 8am
    expect(g2.incentiveThisTrip).toBe(13); // (3−2)×13
  });

  it("RM44 ANCHOR unchanged: same-day pickup and delivery is unaffected by delivery-day keying", () => {
    // Ipoh (A2) delivered the same weekday it was picked up — the anchor case.
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      truck: PLX2406,
    });
    expect(r.incentiveThisTrip).toBe(44);
  });
});

describe("scoreDropsDetailed - the persisted repeat evidence", () => {
  it("flags the flat-1 branch, not the value 1: a 1-point zone's FIRST drop is not a repeat", () => {
    const scored = scoreDropsDetailed([
      { zoneCode: "P2", zonePoints: 1 }, // first P2 today: full points (1) - NOT a repeat
      { zoneCode: "P2", zonePoints: 1 }, // second P2 today: the repeat rule fires (also 1)
      { zoneCode: "A2", zonePoints: 6 },
    ]);
    expect(scored.map((s) => s.points)).toEqual([1, 1, 6]);
    expect(scored.map((s) => s.wasRepeat)).toEqual([false, true, false]);
  });

  it("counts a zone already hit earlier today (on another trip) as a repeat", () => {
    const scored = scoreDropsDetailed([{ zoneCode: "K1", zonePoints: 3 }], ["K1"]);
    expect(scored[0]).toEqual({ points: 1, wasRepeat: true });
  });

  it("matches scoreDrops exactly (same algorithm, one implementation)", () => {
    const drops = [
      { zoneCode: "A2", zonePoints: 6 },
      { zoneCode: "K1", zonePoints: 3 },
      { zoneCode: "A2", zonePoints: 6 },
    ];
    expect(scoreDropsDetailed(drops, ["K1"]).map((s) => s.points)).toEqual(
      scoreDrops(drops, ["K1"])
    );
  });
});

describe("calculateDeliveryIncentive - breakdown fields persisted at finalization", () => {
  it("RM44 anchor: the evidence matches the money exactly, and the money is unchanged", () => {
    const r = calculateDeliveryIncentive({
      rateDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0, // day's first drop
      publicHolidays: NO_HOLIDAYS,
      truck: PLX2406,
    });
    expect(r.incentiveThisTrip).toBe(44); // the anchor - unchanged by this feature
    expect(r.dropPoints).toEqual([6]);
    expect(r.wasRepeat).toEqual([false]);
    expect(r.rateUsed).toBe(11);
    expect(r.isOffPeak).toBe(false);
    expect(r.deductionApplied).toBe(2);
  });
});
