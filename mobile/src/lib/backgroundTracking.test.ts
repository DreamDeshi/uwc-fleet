import { describe, it, expect } from "vitest";
import { shouldTrackInBackground, backgroundTrackingAction } from "./backgroundTracking";

describe("shouldTrackInBackground", () => {
  it("only true when active AND consented AND background permission granted", () => {
    expect(shouldTrackInBackground(true, true, true)).toBe(true);
  });
  it("false if any condition is missing — falls back to the foreground path", () => {
    expect(shouldTrackInBackground(false, true, true)).toBe(false); // trip not active
    expect(shouldTrackInBackground(true, false, true)).toBe(false); // not consented
    expect(shouldTrackInBackground(true, true, false)).toBe(false); // no "Allow all the time"
  });
});

describe("backgroundTrackingAction — reconcile desired vs running", () => {
  it("noop when nothing should run and nothing is running", () => {
    expect(backgroundTrackingAction(null, null)).toBe("noop");
  });
  it("noop when already tracking the right trip", () => {
    expect(backgroundTrackingAction("t1", "t1")).toBe("noop");
  });
  it("starts when a trip should be tracked and nothing is running", () => {
    expect(backgroundTrackingAction("t1", null)).toBe("start");
  });
  it("STOPS when a trip ended but the task is still running — the leak guard", () => {
    expect(backgroundTrackingAction(null, "t1")).toBe("stop");
  });
  it("restarts when the driver switched to a different trip", () => {
    expect(backgroundTrackingAction("t2", "t1")).toBe("restart");
  });
});
