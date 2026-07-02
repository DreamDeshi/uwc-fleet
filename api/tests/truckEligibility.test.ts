import { describe, it, expect } from "vitest";
import { isDocExpired, truckExpiryIssues, roadworthyWhere } from "../src/services/truckEligibility";
import { getTripDayStart } from "../src/services/incentiveEngine";

/**
 * Roadworthiness gate: expired insurance / road tax = hard dispatch block,
 * expired permit = manual-only override, null date = not blocked. A document
 * is valid THROUGH its MYT expiry day.
 */

// "Today" for these tests: Thu 2026-07-02 10:00 MYT.
const NOW = new Date("2026-07-02T02:00:00Z");
const YESTERDAY = new Date("2026-07-01T00:00:00Z");
const TODAY = new Date("2026-07-02T00:00:00Z");
const NEXT_WEEK = new Date("2026-07-09T00:00:00Z");

describe("isDocExpired — valid through the MYT expiry day", () => {
  it("expired only when the expiry day is strictly before today", () => {
    expect(isDocExpired(YESTERDAY, NOW)).toBe(true);
    expect(isDocExpired(TODAY, NOW)).toBe(false); // still valid ON the expiry date
    expect(isDocExpired(NEXT_WEEK, NOW)).toBe(false);
  });

  it("no date on record never blocks (alerts chase missing data instead)", () => {
    expect(isDocExpired(null, NOW)).toBe(false);
  });

  it("compares MYT days, not raw instants", () => {
    // Expiry stored at 2026-07-01T20:00Z = 2026-07-02 04:00 MYT → the MYT
    // expiry day IS today → still valid, even though the instant is past.
    expect(isDocExpired(new Date("2026-07-01T20:00:00Z"), NOW)).toBe(false);
  });
});

describe("truckExpiryIssues — hard docs vs overridable permit", () => {
  it("expired insurance and road tax are hard; permit is separate", () => {
    const issues = truckExpiryIssues(
      { insurance_expiry: YESTERDAY, road_tax_expiry: YESTERDAY, permit_expiry: YESTERDAY },
      NOW
    );
    expect(issues.hard.map((h) => h.doc).sort()).toEqual(["insurance", "road tax"]);
    expect(issues.permitExpired).toEqual(YESTERDAY);
  });

  it("a fully valid truck has no issues", () => {
    const issues = truckExpiryIssues(
      { insurance_expiry: NEXT_WEEK, road_tax_expiry: TODAY, permit_expiry: null },
      NOW
    );
    expect(issues.hard).toEqual([]);
    expect(issues.permitExpired).toBeNull();
  });

  it("only the permit expired → no hard block, permit flagged", () => {
    const issues = truckExpiryIssues(
      { insurance_expiry: NEXT_WEEK, road_tax_expiry: NEXT_WEEK, permit_expiry: YESTERDAY },
      NOW
    );
    expect(issues.hard).toEqual([]);
    expect(issues.permitExpired).toEqual(YESTERDAY);
  });
});

describe("roadworthyWhere — the SQL form matches the pure rule", () => {
  it("matches rows the same way truckExpiryIssues does", () => {
    const trucks = [
      { insurance_expiry: NEXT_WEEK, road_tax_expiry: NEXT_WEEK, permit_expiry: NEXT_WEEK }, // fine
      { insurance_expiry: YESTERDAY, road_tax_expiry: NEXT_WEEK, permit_expiry: NEXT_WEEK }, // hard
      { insurance_expiry: null, road_tax_expiry: null, permit_expiry: null }, // no data → fine
      { insurance_expiry: NEXT_WEEK, road_tax_expiry: NEXT_WEEK, permit_expiry: YESTERDAY }, // permit
      { insurance_expiry: TODAY, road_tax_expiry: TODAY, permit_expiry: TODAY }, // expiry day → fine
    ];
    const w = roadworthyWhere(NOW);
    const dayStart = getTripDayStart(NOW);
    // Simulate the SQL: each AND'd OR = (field IS NULL OR field >= dayStart).
    const gte = (d: Date | null) => d === null || d.getTime() >= dayStart.getTime();
    const sqlEligible = trucks.filter(
      (t) => gte(t.insurance_expiry) && gte(t.road_tax_expiry) && gte(t.permit_expiry)
    );
    const pureEligible = trucks.filter((t) => {
      const i = truckExpiryIssues(t, NOW);
      return i.hard.length === 0 && i.permitExpired === null;
    });
    expect(sqlEligible).toEqual(pureEligible);
    expect(w.AND).toHaveLength(3);
    expect(sqlEligible).toHaveLength(3);
  });
});
