import { describe, it, expect } from "vitest";
import {
  isOffPeak,
  scoreDrops,
  isDocumentationComplete,
  calculateDeliveryIncentive,
  getTripDayStart,
  getTripDayEnd,
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
    // 2026-06-23 17:00 UTC = Wed 2026-06-24 01:00 MYT → holiday, even though
    // the UTC date is still the 23rd.
    expect(isOffPeak(new Date("2026-06-23T17:00:00Z"), holiday)).toBe(true);
    // 2026-06-24 17:00 UTC = Thu 2026-06-25 01:00 MYT → NOT the holiday any
    // more (a UTC-keyed check would wrongly say it is).
    expect(isOffPeak(new Date("2026-06-24T17:00:00Z"), holiday)).toBe(false);
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
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
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
      pickupDateTime: offpeakEvening,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
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
      pickupDateTime: offpeakEvening,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: PRH5292,
    });
    expect(r.rateUsed).toBe(9);
    expect(r.incentiveThisTrip).toBe(36);
  });

  it("applies each truck's own deduction (17.5ft lorry: 3 pts) on a K2 first drop: (4−3)×10 = RM10", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "K2", zonePoints: 4 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: TRUCK_17_5,
    });
    expect(r.incentiveThisTrip).toBe(10);
  });

  it("floors the deducted first drop at 0 (P2=1 pt − 2 pt deduction → RM0)", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "P2", zonePoints: 1 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: PLX2406,
    });
    expect(r.incentiveThisTrip).toBe(0);
    expect(r.deductionApplied).toBe(1); // only the 1 available point is absorbed; remainder not carried
  });
});

describe("calculateDeliveryIncentive — multi-trip day (marginals sum, deduction once)", () => {
  // Ipoh(6) → Kulim(3) → Penang(3), three single-stop trips, PLX 2406 weekday.
  // Pre-deduction zone points = 6+3+3 = 12; deduction (2) applied once on trip 1.
  it("scores three different-zone trips and sums marginals to the day total", () => {
    const t1 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: PLX2406,
    });
    const t2 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: ["A2"],
      isFirstDeliveredDropOfDay: false,
      truck: PLX2406,
    });
    const t3 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "P1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: ["A2", "K1"],
      isFirstDeliveredDropOfDay: false,
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
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: PLX2406,
    });
    const t2 = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: ["K1"],
      isFirstDeliveredDropOfDay: false,
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
      pickupDateTime: weekdayMorning,
      drops: [
        { zoneCode: "K1", zonePoints: 3 },
        { zoneCode: "K1", zonePoints: 3 },
      ],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
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
      pickupDateTime: weekdayMorning,
      drops: [
        { zoneCode: "K1", zonePoints: 3 },
        { zoneCode: "A2", zonePoints: 6 },
      ],
      zonesDeliveredEarlierToday: ["K1"],
      isFirstDeliveredDropOfDay: false,
      truck: PLX2406,
    });
    expect(r.dropPoints).toEqual([1, 6]);
    expect(r.deductionApplied).toBe(0);
    expect(r.incentiveThisTrip).toBe(77); // (1 + 6) × 11
  });
});

describe("calculateDeliveryIncentive — the admin holiday calendar drives the rate tier", () => {
  // weekdayMorning is Monday 9am MYT (2026-06-22). Same instant, two calendars.
  it("pays the off-peak rate when the pickup's MYT day is in the calendar", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: new Set(["2026-06-22"]),
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: PLX2406,
    });
    expect(r.isOffPeak).toBe(true);
    expect(r.rateUsed).toBe(13);
    expect(r.incentiveThisTrip).toBe(52); // (6−2)×13
  });

  it("the same trip with an empty calendar pays the weekday rate (no baked-in list)", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      pickupDateTime: weekdayMorning,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      truck: PLX2406,
    });
    expect(r.rateUsed).toBe(11);
    expect(r.incentiveThisTrip).toBe(44); // the anchor, unaffected
  });
});
