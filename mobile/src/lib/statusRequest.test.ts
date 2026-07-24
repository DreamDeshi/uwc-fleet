import { describe, expect, it } from "vitest";
import { statusRequestBody } from "./statusRequest";

/**
 * The driver Arrived/Delivered request must carry NO client-chosen timestamp —
 * the server clocks the moment the tap is received (Mr. Teh, 23 Jul 2026). Both
 * the online mutation (hooks/queries.ts) and the offline outbox replay
 * (hooks/usePodOutbox.ts) build their body through statusRequestBody, so this
 * pins the exact wire shape they send.
 */
describe("statusRequestBody — the timestamp-free status request", () => {
  it("sends exactly action + stop_id for arrived", () => {
    expect(statusRequestBody("arrived", "s1")).toEqual({ action: "arrived", stop_id: "s1" });
  });

  it("carries NO timestamp/date field for any action", () => {
    for (const action of ["start", "arrived", "delivered"] as const) {
      const body = statusRequestBody(action, "s1");
      // The ONLY keys are action + stop_id — a driver-chosen arrival time cannot ride along.
      expect(Object.keys(body).sort()).toEqual(["action", "stop_id"]);
      for (const key of Object.keys(body)) {
        expect(key, `unexpected time-like field "${key}"`).not.toMatch(/time|date|arrived_at|delivered_at|_at$|clock|ts/i);
      }
    }
  });

  it("omits stop_id when not provided (start has no stop) — still no timestamp", () => {
    const body = statusRequestBody("start");
    expect(body.action).toBe("start");
    expect(body.stop_id).toBeUndefined();
    expect("arrived_at" in body).toBe(false);
  });

  it("ignores any extra caller intent — the return shape is fixed", () => {
    // Even though callers only ever pass (action, stop_id), pin that the helper
    // never fabricates or forwards a timestamp of its own.
    const serialized = JSON.stringify(statusRequestBody("arrived", "s9"));
    expect(serialized).toBe('{"action":"arrived","stop_id":"s9"}');
  });
});
