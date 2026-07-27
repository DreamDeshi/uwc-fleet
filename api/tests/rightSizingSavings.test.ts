import { afterEach, describe, expect, it } from "vitest";
import {
  defaultRightSizingConfig,
  rightSizingSavings,
  truckClass,
} from "../src/lib/rightSizingSavings";

const ENV_KEYS = ["EST_L100_10T", "EST_L100_5T", "EST_L100_1T", "EST_KM_PER_TRIP", "FUEL_CO2E_KG_PER_LITRE"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("truckClass", () => {
  it("extracts the tonnage prefix from the free-text type", () => {
    expect(truckClass("10t-30ft")).toBe("10t");
    expect(truckClass("5t-17.5ft")).toBe("5t");
    expect(truckClass("1t")).toBe("1t");
  });

  it("maps unclassed and missing types to null", () => {
    expect(truckClass("Generic")).toBeNull();
    expect(truckClass("")).toBeNull();
    expect(truckClass(null)).toBeNull();
    expect(truckClass(undefined)).toBeNull();
  });
});

describe("rightSizingSavings", () => {
  it("estimates litres from the class gap, once per trip", () => {
    // Defaults: 10t=32, 5t=22, 1t=12 L/100km; 35 km/trip; 2.68 kg/L.
    const r = rightSizingSavings(["10t-30ft", "5t-17.5ft", "1t", "Generic", null], "10t-30ft");
    expect(r.trips).toBe(5);
    // 5t and 1t are right-sized; 10t (== largest), Generic and null claim nothing.
    expect(r.tripsRightSized).toBe(2);
    // 0.35 × (32−22) + 0.35 × (32−12) = 3.5 + 7 = 10.5 L
    expect(r.estLitresSaved).toBe(10.5);
    expect(r.estCo2eKgSaved).toBe(28.14);
  });

  it("claims nothing when the largest truck class is unknown", () => {
    const r = rightSizingSavings(["5t-17.5ft", "1t"], "Generic");
    expect(r.trips).toBe(2);
    expect(r.tripsRightSized).toBe(0);
    expect(r.estLitresSaved).toBe(0);
    expect(r.estCo2eKgSaved).toBe(0);
  });

  it("is empty-safe", () => {
    expect(rightSizingSavings([], "10t-30ft")).toEqual({
      trips: 0,
      tripsRightSized: 0,
      estLitresSaved: 0,
      estCo2eKgSaved: 0,
    });
  });

  it("honours env overrides and keeps safe defaults on garbage", () => {
    process.env.EST_L100_10T = "40";
    process.env.EST_L100_5T = "garbage";
    process.env.EST_KM_PER_TRIP = "-5";
    const cfg = defaultRightSizingConfig();
    expect(cfg.l100ByClass["10t"]).toBe(40);
    expect(cfg.l100ByClass["5t"]).toBe(22); // garbage → default
    expect(cfg.kmPerTrip).toBe(35); // non-positive → default
  });
});
