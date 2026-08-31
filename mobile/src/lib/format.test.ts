import { describe, it, expect } from "vitest";
import { formatMoney } from "./format";

/**
 * ⚠ Found in code review 31 Aug 2026: this formatMoney used to print a whole
 * number with no decimals ("RM 44"), while admin/lib/format.ts's formatMoney
 * — used to review the SAME incentive figures — is always 2dp ("RM 44.00").
 * A driver on Earnings and an admin approving the same stop could therefore
 * see differently-precise numbers for the identical amount. No test pinned
 * either behaviour before this fix.
 */
describe("formatMoney — driver-facing, must match admin's 2dp convention", () => {
  it("a whole number still shows 2 decimals", () => {
    expect(formatMoney(44)).toBe("RM 44.00");
  });

  it("a fractional value keeps its 2 decimals", () => {
    expect(formatMoney(44.55)).toBe("RM 44.55");
  });

  it("rounds to 2dp rather than truncating or growing", () => {
    expect(formatMoney(44.5)).toBe("RM 44.50");
    expect(formatMoney(44.999)).toBe("RM 45.00");
  });

  it("a Decimal-as-string value from the API formats the same as a number", () => {
    expect(formatMoney("44")).toBe("RM 44.00");
    expect(formatMoney("44.55")).toBe("RM 44.55");
  });

  it("null/undefined/non-finite fall back to zero, still 2dp", () => {
    expect(formatMoney(null)).toBe("RM 0.00");
    expect(formatMoney(undefined)).toBe("RM 0.00");
    expect(formatMoney(Number.NaN)).toBe("RM 0.00");
  });

  it("thousands separator matches admin's en-MY locale", () => {
    expect(formatMoney(1234.5)).toBe("RM 1,234.50");
  });
});
