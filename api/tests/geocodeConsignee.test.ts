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

  it("stores NULL coords (never a bad guess) for coarse or failed results, keeping the verbatim type", () => {
    for (const t of ["GEOMETRIC_CENTER", "APPROXIMATE", "ZERO_RESULTS", "RETRY_EXHAUSTED", "ERROR"]) {
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
