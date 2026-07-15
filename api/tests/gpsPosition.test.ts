import { describe, it, expect } from "vitest";
import { resolveFleetFix, GPS_STALE_AFTER_MS } from "../src/lib/gpsPosition";

const NOW = 1_700_000_000_000;
// A log recorded `msAgo` before NOW. Logs must be passed NEWEST-first.
const at = (msAgo: number, source: string, lat = 1, lng = 2) => ({
  latitude: lat,
  longitude: lng,
  recorded_at: new Date(NOW - msAgo),
  source,
});

describe("resolveFleetFix — source preference (vendor > phone > absent)", () => {
  it("returns null with no logs (caller falls back to the approximate pill)", () => {
    expect(resolveFleetFix([], NOW)).toBeNull();
  });

  it("prefers the freshest VENDOR fix even when a phone fix is newer", () => {
    const logs = [at(10_000, "phone", 10, 20), at(60_000, "vendor", 30, 40)]; // newest-first
    const fix = resolveFleetFix(logs, NOW)!;
    expect(fix.source).toBe("vendor");
    expect(fix.latitude).toBe(30);
    expect(fix.stale).toBe(false);
  });

  it("falls back to the freshest PHONE fix when no vendor fix is fresh", () => {
    const logs = [at(10_000, "phone", 10, 20), at(4 * 60_000, "vendor", 30, 40)]; // vendor stale
    const fix = resolveFleetFix(logs, NOW)!;
    expect(fix.source).toBe("phone");
    expect(fix.latitude).toBe(10);
    expect(fix.stale).toBe(false);
  });

  it("uses the latest overall fix, marked STALE, when nothing is fresh", () => {
    const logs = [at(5 * 60_000, "phone", 10, 20), at(9 * 60_000, "vendor", 30, 40)];
    const fix = resolveFleetFix(logs, NOW)!;
    expect(fix.source).toBe("phone"); // latest overall (5min beats 9min)
    expect(fix.stale).toBe(true);
  });

  it("a single fresh phone fix → phone, not stale", () => {
    const fix = resolveFleetFix([at(20_000, "phone")], NOW)!;
    expect(fix.source).toBe("phone");
    expect(fix.stale).toBe(false);
  });

  it("staleness boundary keys on GPS_STALE_AFTER_MS", () => {
    expect(resolveFleetFix([at(GPS_STALE_AFTER_MS - 1, "phone")], NOW)!.stale).toBe(false);
    expect(resolveFleetFix([at(GPS_STALE_AFTER_MS + 1, "phone")], NOW)!.stale).toBe(true);
  });
});
