import { describe, expect, it } from "vitest";
import {
  buildQuery,
  geocodeStoreFields,
  isCareOf,
  isUsable,
  USABLE_TYPES,
} from "../src/lib/geocodeConsignee";

describe("buildQuery", () => {
  it("joins address_1, area, postcode, state, Malaysia — company name never appears", () => {
    const q = buildQuery({
      address_1: "12, Jalan Perindustrian 3,",
      address_2: "Taman Perindustrian",
      area: "Bukit Minyak",
      state: "Penang",
      postal_code: "14100",
    });
    expect(q).toBe("12, Jalan Perindustrian 3, Bukit Minyak, 14100, Penang, Malaysia");
  });

  it("appends address_2 only for C/O rows", () => {
    const base = { area: "Juru", state: "Penang", postal_code: "14100" };
    expect(buildQuery({ address_1: "C/O Acme Warehouse", address_2: "Lot 5, Jalan X", ...base })).toContain("Lot 5, Jalan X");
    expect(buildQuery({ address_1: "12 Jalan Y", address_2: "Lot 5, Jalan X", ...base })).not.toContain("Lot 5");
  });

  it("drops empty parts", () => {
    expect(buildQuery({ address_1: null, address_2: null, area: null, state: null, postal_code: "14100" })).toBe(
      "14100, Malaysia"
    );
  });
});

describe("isCareOf", () => {
  it("detects c/o variants", () => {
    expect(isCareOf("C/O Somebody")).toBe(true);
    expect(isCareOf("  c / o Somebody")).toBe(true);
    expect(isCareOf("12 Jalan Company")).toBe(false);
    expect(isCareOf(null)).toBe(false);
  });
});

describe("geocodeStoreFields — the write-time precision gate", () => {
  it("stores coordinates only for ROOFTOP / RANGE_INTERPOLATED", () => {
    for (const t of USABLE_TYPES) {
      expect(isUsable(t)).toBe(true);
      expect(geocodeStoreFields({ lat: 5.35, lng: 100.4, locationType: t })).toEqual({
        latitude: 5.35,
        longitude: 100.4,
        geocode_match_type: t,
      });
    }
  });

  /**
   * ⚠ THIS CASE WAS DELIBERATELY NARROWED, 18 Aug 2026 — it is not a test that
   * was "fixed until it passed".
   *
   * It used to list GEOMETRIC_CENTER and APPROXIMATE alongside the failures,
   * because the gate discarded everything below building grade. That is
   * precisely what left 349 production consignees navigating to a zone
   * centroid up to 26.94 km away, so the gate now STORES those two and records
   * the grade instead. Their new expectation lives in geocodePrecision.test.ts
   * ("stores road-level and area-level coordinates that used to be discarded"),
   * and the grade is what keeps them out of the early-tap judgement.
   *
   * What survives here is the part that did not change: a NON-ANSWER stores no
   * position. Inventing one would be the bad guess this always refused.
   */
  it("stores NULL coords (never a bad guess) for a NON-ANSWER, keeping the verbatim type", () => {
    for (const t of ["ZERO_RESULTS", "RETRY_EXHAUSTED", "ERROR"]) {
      expect(geocodeStoreFields({ lat: 5.35, lng: 100.4, locationType: t })).toEqual({
        latitude: null,
        longitude: null,
        geocode_match_type: t,
      });
    }
  });

  it("never stores a usable type with half-missing coordinates", () => {
    expect(geocodeStoreFields({ lat: 5.35, lng: null, locationType: "ROOFTOP" })).toEqual({
      latitude: null,
      longitude: null,
      geocode_match_type: "ROOFTOP",
    });
  });
});
