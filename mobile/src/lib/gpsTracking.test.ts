import { describe, it, expect } from "vitest";
import { trackingGate } from "./gpsTracking";

// The privacy rule: capture ONLY when the trip is active AND the driver consented.
describe("trackingGate", () => {
  it("idle when the trip is not active — regardless of consent", () => {
    expect(trackingGate(false, true)).toBe("idle");
    expect(trackingGate(false, false)).toBe("idle");
  });

  it("needs_consent when the trip is active but the driver hasn't agreed", () => {
    expect(trackingGate(true, false)).toBe("needs_consent");
  });

  it("active ONLY when the trip is active AND consented", () => {
    expect(trackingGate(true, true)).toBe("active");
  });
});
