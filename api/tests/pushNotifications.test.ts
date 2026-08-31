import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPushNotifications } from "../src/lib/pushNotifications";

/**
 * ⚠ THE PUSH THAT WENT TO NOBODY (AGENTS.md). Before this fix,
 * sendPushNotifications([]) resolved cleanly with no return value and no log
 * line, so every one of the ~20 call sites across the codebase treated a real
 * send and a send to zero recipients as the identical non-event — found in
 * code review 31 Aug 2026. This suite pins the two things that changed: the
 * function now LOGS a zero-recipient send, and its return value actually
 * tells the caller how many recipients it reached.
 */

function fetchOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response)
  );
}

describe("sendPushNotifications — zero-recipient visibility", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("an EMPTY token list logs a warning naming the notification and returns recipients: 0", async () => {
    const result = await sendPushNotifications([], { title: "Trip awaiting approval", body: "…" });
    expect(result).toEqual({ recipients: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/Trip awaiting approval/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/0 recipients/);
  });

  it("a list of null/undefined/garbage tokens (no real Expo token among them) is the SAME finding as an empty list", async () => {
    // This is the shape every real call site actually passes — e.g.
    // admins.map(a => a.expo_push_token) when nobody has registered one, or
    // [trip.driver?.expo_push_token] when the driver never opened the app on
    // a device that can hold a token. An empty ARRAY is the rare case; a full
    // array of nulls is what "nobody has a token" actually looks like.
    const result = await sendPushNotifications([null, undefined, "not-a-real-token"], {
      title: "Pending trip",
      body: "…",
    });
    expect(result).toEqual({ recipients: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/3 candidate token/);
  });

  it("⚠ a REAL recipient produces neither the warning NOR a zero count — the fixture must discriminate", async () => {
    fetchOk();
    const result = await sendPushNotifications(["ExponentPushToken[abc123]"], {
      title: "Trip started",
      body: "…",
    });
    expect(result).toEqual({ recipients: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("mixes valid and invalid tokens — recipients counts only the valid ones, no warning fires", async () => {
    fetchOk();
    const result = await sendPushNotifications(
      ["ExponentPushToken[abc123]", null, "garbage"],
      { title: "Trip started", body: "…" }
    );
    expect(result).toEqual({ recipients: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
