import { describe, it, expect } from "vitest";
import { estimateIncentive, consigneeAddress } from "./trip";
import type { Trip } from "../types";

// The address the driver reads on the stop card. It is also the backstop for a
// wrong pin, so an empty/partial row must degrade cleanly rather than render
// stray punctuation like ", , PENANG".
describe("consigneeAddress", () => {
  it("builds the full address, postcode joined to the area Malaysian-style", () => {
    expect(
      consigneeAddress({
        address_1: "NO.5,LORONG PERDA UTAMA 10,",
        area: "BUKIT MERTAJAM",
        postal_code: "14000",
        state: "PENANG",
      })
    ).toBe("NO.5,LORONG PERDA UTAMA 10, 14000 BUKIT MERTAJAM, PENANG");
  });

  it("includes address_2 — on a C/O row it holds the only real street text", () => {
    const a = consigneeAddress({
      address_1: "C/O KINTETSU WORLDWIDE EXPRESS (M) S/B",
      address_2: "GRID K8-K19, BLOCK B, CARGO COMPLEX",
      area: "BAYAN LEPAS",
      postal_code: "11900",
      state: "PENANG",
    });
    expect(a).toContain("GRID K8-K19, BLOCK B, CARGO COMPLEX");
    expect(a).toContain("11900 BAYAN LEPAS");
  });

  it("drops empty components instead of emitting empty comma runs", () => {
    expect(consigneeAddress({ address_1: "JALAN X", state: "PENANG" })).toBe("JALAN X, PENANG");
    expect(consigneeAddress({ area: "KULIM", state: "KEDAH" })).toBe("KULIM, KEDAH");
    expect(consigneeAddress({ address_1: "  ", address_2: null, state: null })).toBe("");
  });

  it("returns empty for a missing row so the caller can fall back", () => {
    expect(consigneeAddress(null)).toBe("");
    expect(consigneeAddress(undefined)).toBe("");
    expect(consigneeAddress({})).toBe("");
  });
});

/**
 * The client's "Estimated incentive" mirrors the server's incentiveEngine rate
 * tier. These two have drifted before (the old baked-in holiday list carried
 * wrong dates), and drift here is user-visible in the worst way: the driver is
 * shown one number and paid another.
 *
 * The tier band is the workbook's, both ends: PEAK is "Weekday 8am - 6pm", so
 * off-peak is Sat/Sun, public holidays, and any weekday hour at/after 18:00 OR
 * before 08:00. The morning end was missing until 17 Jul 2026 (server and
 * client both only tested `hour >= 18`), which showed early-morning work at the
 * lower peak rate.
 *
 * NOTE these estimates anchor on PICKUP time — the client can't know the
 * delivery-confirm instant the server will actually rate from (documented in
 * estimateIncentive). The BAND under test is identical either way.
 */

const NO_HOLIDAYS: ReadonlySet<string> = new Set();

const PLX = {
  plate: "PLX 2406",
  entitled_claim_weekday: 11,
  entitled_claim_offpeak: 13,
  daily_deduction_points: 2,
};

// A wall-clock MYT hour on Wednesday 2026-07-15, as the UTC instant stored.
function mytWeekday(hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 6, 15, hour - 8, minute)).toISOString();
}

// One Kulim (K1 = 3 pts) drop: (3 − 2 deduction) × rate = 1 × rate.
function tripAt(pickupIso: string): Trip {
  return {
    pickup_datetime: pickupIso,
    truck: PLX,
    stops: [{ sequence: 1, consignee: { zone_code: "K1" } }],
  } as unknown as Trip;
}

describe("estimateIncentive — the rate band mirrors the server exactly", () => {
  it("uses the PEAK rate at 08:00 MYT, the moment the band opens", () => {
    expect(estimateIncentive(tripAt(mytWeekday(8, 0)), NO_HOLIDAYS)).toBe(11);
  });

  it("uses the PEAK rate at midday", () => {
    expect(estimateIncentive(tripAt(mytWeekday(12, 0)), NO_HOLIDAYS)).toBe(11);
  });

  it("uses the PEAK rate at 17:59, the last minute of the band", () => {
    expect(estimateIncentive(tripAt(mytWeekday(17, 59)), NO_HOLIDAYS)).toBe(11);
  });

  it("flips to the OFF-PEAK rate at 18:00 exactly", () => {
    expect(estimateIncentive(tripAt(mytWeekday(18, 0)), NO_HOLIDAYS)).toBe(13);
  });

  it("uses the OFF-PEAK rate at 07:59, the last minute before the band opens", () => {
    expect(estimateIncentive(tripAt(mytWeekday(7, 59)), NO_HOLIDAYS)).toBe(13);
  });

  it("uses the OFF-PEAK rate at 07:00 — the hour the operating window opens", () => {
    expect(estimateIncentive(tripAt(mytWeekday(7, 0)), NO_HOLIDAYS)).toBe(13);
  });

  it("uses the OFF-PEAK rate at 02:00 — the latest pickup allowed (item 12)", () => {
    expect(estimateIncentive(tripAt(mytWeekday(2, 0)), NO_HOLIDAYS)).toBe(13);
  });

  it("uses the OFF-PEAK rate at midnight exactly", () => {
    expect(estimateIncentive(tripAt(mytWeekday(0, 0)), NO_HOLIDAYS)).toBe(13);
  });

  it("prices every weekday hour off-peak iff outside [08:00, 18:00)", () => {
    for (let hour = 0; hour < 24; hour++) {
      const peak = hour >= 8 && hour < 18;
      expect(estimateIncentive(tripAt(mytWeekday(hour, 0)), NO_HOLIDAYS), `hour ${hour}`).toBe(
        peak ? 11 : 13
      );
    }
  });

  it("is OFF-PEAK all day Saturday regardless of the hour", () => {
    const satNoon = new Date(Date.UTC(2026, 6, 18, 12 - 8)).toISOString(); // 2026-07-18 = Sat
    expect(estimateIncentive(tripAt(satNoon), NO_HOLIDAYS)).toBe(13);
  });

  it("is OFF-PEAK inside the peak band on a public holiday", () => {
    expect(estimateIncentive(tripAt(mytWeekday(12, 0)), new Set(["2026-07-15"]))).toBe(13);
  });

  it("returns null without a truck (no rate to read)", () => {
    const t = { ...tripAt(mytWeekday(12, 0)), truck: null } as unknown as Trip;
    expect(estimateIncentive(t, NO_HOLIDAYS)).toBeNull();
  });
});
