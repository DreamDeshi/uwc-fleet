import { afterEach, describe, expect, it } from "vitest";
import { earlyTapDistanceM, isEarlyTap } from "../src/lib/earlyTap";
import { attentionConfig } from "../src/services/attention";

const T0 = new Date("2026-07-27T10:00:00Z");
const at = (minOffset: number) => new Date(T0.getTime() + minOffset * 60 * 1000);

// ~5.35N 100.4E is the Penang mainland; 0.001° lat ≈ 111 m.
const CONSIGNEE = { latitude: 5.35, longitude: 100.4 };
const NEAR = { latitude: 5.3502, longitude: 100.4 }; // ≈ 22 m
const FAR = { latitude: 5.36, longitude: 100.4 }; // ≈ 1.1 km

describe("earlyTapDistanceM", () => {
  it("returns null for a consignee without coordinates — even with a far fix", () => {
    const fixes = [{ ...FAR, recorded_at: at(0) }];
    expect(earlyTapDistanceM(T0, fixes, { latitude: null, longitude: null }, 10)).toBeNull();
    expect(earlyTapDistanceM(T0, fixes, { latitude: 5.35, longitude: null }, 10)).toBeNull();
  });

  it("returns null when no fix falls inside the time window", () => {
    const fixes = [{ ...FAR, recorded_at: at(-11) }, { ...FAR, recorded_at: at(15) }];
    expect(earlyTapDistanceM(T0, fixes, CONSIGNEE, 10)).toBeNull();
  });

  it("uses the fix nearest in time, not the nearest in space", () => {
    const fixes = [
      { ...NEAR, recorded_at: at(-9) }, // near in space, older
      { ...FAR, recorded_at: at(-1) }, // far in space, nearest in time
    ];
    const d = earlyTapDistanceM(T0, fixes, CONSIGNEE, 10);
    expect(d).toBeGreaterThan(1000);
  });

  it("measures roughly the right distance", () => {
    const d = earlyTapDistanceM(T0, [{ ...NEAR, recorded_at: at(0) }], CONSIGNEE, 10);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(40);
  });
});

describe("isEarlyTap", () => {
  it("flags strictly beyond the radius; null never flags", () => {
    expect(isEarlyTap(null, 500)).toBe(false);
    expect(isEarlyTap(499, 500)).toBe(false);
    expect(isEarlyTap(500, 500)).toBe(false);
    expect(isEarlyTap(501, 500)).toBe(true);
  });
});

describe("attentionConfig early-tap thresholds", () => {
  const KEYS = ["ATTENTION_EARLY_TAP_RADIUS_M", "ATTENTION_EARLY_TAP_WINDOW_MIN"];
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to 500 m / 10 min", () => {
    const cfg = attentionConfig();
    expect(cfg.earlyTapRadiusM).toBe(500);
    expect(cfg.earlyTapWindowMin).toBe(10);
  });

  it("honours env overrides and keeps safe defaults on garbage", () => {
    process.env.ATTENTION_EARLY_TAP_RADIUS_M = "250";
    process.env.ATTENTION_EARLY_TAP_WINDOW_MIN = "junk";
    const cfg = attentionConfig();
    expect(cfg.earlyTapRadiusM).toBe(250);
    expect(cfg.earlyTapWindowMin).toBe(10);
  });
});
