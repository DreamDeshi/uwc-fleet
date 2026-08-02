import { describe, it, expect } from "vitest";
import {
  MIN_CHECK_INTERVAL_MS,
  isForegroundTransition,
  shouldCheckOnForeground,
  type OtaPhase,
} from "./otaUpdatePolicy";

const T0 = 1_770_000_000_000; // fixed epoch — never Date.now() in a test

describe("when a foreground event may trigger an update check", () => {
  it("checks on the first foreground of the session", () => {
    // The whole point of the change: this is the check the driver's
    // close-and-reopen cycle never performed, because resuming a live process
    // is not a process start.
    expect(shouldCheckOnForeground({ phase: "idle", lastCheckAt: null, now: T0 })).toBe(true);
  });

  it("does not check again inside the throttle window", () => {
    expect(
      shouldCheckOnForeground({ phase: "idle", lastCheckAt: T0, now: T0 + MIN_CHECK_INTERVAL_MS - 1 })
    ).toBe(false);
  });

  it("checks again once the window has elapsed", () => {
    expect(
      shouldCheckOnForeground({ phase: "idle", lastCheckAt: T0, now: T0 + MIN_CHECK_INTERVAL_MS })
    ).toBe(true);
  });

  // ⚠ THE POD-CAPTURE BURST. Taking a delivery photo backgrounds the app to
  // launch the camera and foregrounds it again on return, so a driver working a
  // stop generates foreground events seconds apart. Only the first may cost a
  // network request; if this regresses, every POD capture in the fleet pays for
  // an update check on mobile data.
  it("survives a burst of foregrounds during a POD capture with one check", () => {
    let lastCheckAt: number | null = null;
    let checks = 0;
    for (const offset of [0, 3_000, 8_000, 15_000, 21_000, 40_000]) {
      const now = T0 + offset;
      if (shouldCheckOnForeground({ phase: "idle", lastCheckAt, now })) {
        checks += 1;
        lastCheckAt = now;
      }
    }
    expect(checks).toBe(1);
  });

  it.each(["checking", "downloading"] as OtaPhase[])(
    "does not start a second check while %s",
    (phase) => {
      // An in-flight check with a stale lastCheckAt would otherwise re-enter and
      // race itself into two concurrent downloads of the same bundle.
      expect(shouldCheckOnForeground({ phase, lastCheckAt: null, now: T0 })).toBe(false);
    }
  );

  it("stops checking once an update is downloaded and waiting on the tap", () => {
    // "ready" is terminal until the restart. Re-checking would find the same
    // update and start a second download over the finished one.
    expect(
      shouldCheckOnForeground({ phase: "ready", lastCheckAt: T0, now: T0 + MIN_CHECK_INTERVAL_MS * 10 })
    ).toBe(false);
  });

  it("retries after a failed check once the window passes", () => {
    // Offline in a depot is the common case, and it must not latch: the next
    // qualifying foreground tries again.
    expect(
      shouldCheckOnForeground({ phase: "error", lastCheckAt: T0, now: T0 + MIN_CHECK_INTERVAL_MS })
    ).toBe(true);
  });

  // ⚠ A clock bug hides from a clock. If the device time jumps BACKWARDS past
  // lastCheckAt, an elapsed-time test can strand the app in "never due again"
  // until it is force-quit — the exact failure this change exists to remove.
  it("treats a backwards clock jump as due rather than stalling", () => {
    expect(
      shouldCheckOnForeground({ phase: "idle", lastCheckAt: T0, now: T0 - 3 * 60 * 60 * 1000 })
    ).toBe(true);
  });
});

describe("which AppState transitions count as a foreground", () => {
  it("counts background → active", () => {
    expect(isForegroundTransition("background", "active")).toBe(true);
  });

  it("counts the inactive → active hop Android and iOS emit", () => {
    expect(isForegroundTransition("inactive", "active")).toBe(true);
  });

  it("ignores leaving the foreground", () => {
    expect(isForegroundTransition("active", "background")).toBe(false);
    expect(isForegroundTransition("active", "inactive")).toBe(false);
  });

  // An app that is already active must not re-fire on an incidental blip —
  // the iOS control-centre pull-down and the Android app switcher both emit
  // "inactive" without the app ever leaving the foreground.
  it("ignores active → active", () => {
    expect(isForegroundTransition("active", "active")).toBe(false);
  });
});
