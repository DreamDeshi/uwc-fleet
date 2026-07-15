import { describe, it, expect } from "vitest";
import { resolveRateLimit } from "../src/middleware/rateLimit";

// Mirrors the RATE_LIMIT_MAX rule: a blank/invalid override can never weaken a
// limiter (falls back to the safe default); only a valid non-negative integer
// wins, and 0 explicitly disables.
describe("resolveRateLimit", () => {
  it("falls back on unset / blank / non-integer / negative", () => {
    expect(resolveRateLimit(undefined, 10)).toBe(10);
    expect(resolveRateLimit("", 10)).toBe(10);
    expect(resolveRateLimit("   ", 10)).toBe(10);
    expect(resolveRateLimit("abc", 10)).toBe(10);
    expect(resolveRateLimit("1.5", 10)).toBe(10);
    expect(resolveRateLimit("-3", 10)).toBe(10);
  });

  it("honours a valid non-negative integer, including 0 (disable)", () => {
    expect(resolveRateLimit("25", 10)).toBe(25);
    expect(resolveRateLimit("0", 10)).toBe(0);
  });
});
