import { describe, it, expect } from "vitest";
import { buildQuery, isCareOf, isUsable, ACCEPTED_MATCH_TYPES } from "../scripts/geocode-consignees";

// These pin the three rules the geocoding design turns on. Each was learned from
// a measured failure in the 4-provider bake-off, so a regression here silently
// reintroduces a known-bad geocode.
const row = (o: Partial<Parameters<typeof buildQuery>[0]>) => ({
  address_1: null, address_2: null, area: null, state: null, postal_code: null, ...o,
});

describe("isCareOf", () => {
  it("detects the forwarder forms actually present in the data", () => {
    expect(isCareOf("C/O KINTETSU WORLDWIDE EXPRESS (M) S/B")).toBe(true);
    expect(isCareOf("c/o DHL PROPERTIES (M) SDN BHD")).toBe(true);
    expect(isCareOf("  C / O CARGOTEC SWEDEN AB")).toBe(true);
  });

  it("does NOT fire on a normal street or a mid-string c/o", () => {
    expect(isCareOf("NO.5,LORONG PERDA UTAMA 10,")).toBe(false);
    // Only a LEADING c/o means "address_1 is a company, not a street".
    expect(isCareOf("LOT 1-1,1ST FLOOR,C/O:IXORA HOTEL SDN BHD")).toBe(false);
    expect(isCareOf(null)).toBe(false);
  });
});

describe("buildQuery", () => {
  it("never includes company_name — it is not even an input", () => {
    // The signature has no company_name field; this asserts the shape stays that way.
    const q = buildQuery(row({ address_1: "NO.5,LORONG PERDA UTAMA 10,", area: "BUKIT MERTAJAM", postal_code: "14000", state: "PENANG" }));
    expect(q).toBe("NO.5,LORONG PERDA UTAMA 10, BUKIT MERTAJAM, 14000, PENANG, Malaysia");
  });

  it("EXCLUDES address_2 on a normal row (it is a truncated duplicate = noise)", () => {
    const q = buildQuery(row({ address_1: "48-50,JALAN MAHSURI,", address_2: "48-50,", area: "BAYAN LEPAS", postal_code: "11950", state: "PENANG" }));
    expect(q).not.toContain("48-50,,");
    expect(q).toBe("48-50,JALAN MAHSURI, BAYAN LEPAS, 11950, PENANG, Malaysia");
  });

  it("APPENDS address_2 on a C/O row — that is where the only real street text is", () => {
    // The Keysight row: address_1 names a forwarder, address_2 has the location.
    const q = buildQuery(row({
      address_1: "C/O KINTETSU WORLDWIDE EXPRESS (M) S/B (64448-K)",
      address_2: "GRID K8-K19, BLOCK B, CARGO COMPLEX",
      area: "BAYAN LEPAS", postal_code: "11900", state: "PENANG",
    }));
    expect(q).toContain("GRID K8-K19, BLOCK B, CARGO COMPLEX");
    expect(q).toContain("11900");
  });

  it("tolerates a C/O row with no address_2", () => {
    const q = buildQuery(row({ address_1: "c/o DHL PROPERTIES (M) SDN BHD", area: "BAYAN LEPAS", postal_code: "11900", state: "PENANG" }));
    expect(q).toBe("c/o DHL PROPERTIES (M) SDN BHD, BAYAN LEPAS, 11900, PENANG, Malaysia");
  });

  it("drops trailing commas and empty components", () => {
    expect(buildQuery(row({ address_1: "LOT 57B, KULIM INDUSTRIAL ESTATE,", area: "KULIM", postal_code: "09000", state: "KEDAH" })))
      .toBe("LOT 57B, KULIM INDUSTRIAL ESTATE, KULIM, 09000, KEDAH, Malaysia");
    expect(buildQuery(row({ address_1: "JALAN X", state: "PENANG" }))).toBe("JALAN X, PENANG, Malaysia");
  });
});

describe("isUsable — the match_type gate", () => {
  it("accepts only real positions", () => {
    expect(ACCEPTED_MATCH_TYPES).toEqual(["full_match", "match_by_street"]);
    expect(isUsable("full_match")).toBe(true);
    expect(isUsable("match_by_street")).toBe(true);
  });

  it("REJECTS match_by_postcode — a postcode centroid is not a geocode", () => {
    // Every C/O row in the bake-off came back match_by_postcode; treating those
    // as positions would put drivers kilometres from the building.
    expect(isUsable("match_by_postcode")).toBe(false);
    expect(isUsable("match_by_city_or_disrict")).toBe(false);
    expect(isUsable("unknown")).toBe(false);
    expect(isUsable(null)).toBe(false);
    expect(isUsable(undefined)).toBe(false);
  });
});
