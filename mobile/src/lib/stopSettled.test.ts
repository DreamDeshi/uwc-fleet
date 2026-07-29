import { describe, it, expect } from "vitest";
import { isStopSettled, outstandingStops } from "./stopSettled";

/**
 * The client-side mirror of api/src/services/undeliveredPay.ts. If these two
 * drift, the driver is offered a POD button for a stop the office already
 * closed and paid — or, the other way, a stop he still has to deliver quietly
 * disappears from his rail.
 */

const settled = {
  status: "arrived",
  exceptions: [
    { current_state: "resolved", resolution: "resume", actions: [{ type: "verify" }] },
  ],
};

describe("isStopSettled", () => {
  it("verify + resume → settled (nothing left for the driver)", () => {
    expect(isStopSettled(settled)).toBe(true);
  });

  it("a bare resume with NO verify is NOT settled", () => {
    // An admin unblocking a stuck truck has not adjudicated anything, and the
    // server pays nothing — so the stop is still the driver's to deliver.
    expect(
      isStopSettled({ status: "arrived", exceptions: [{ current_state: "resolved", resolution: "resume", actions: [] }] })
    ).toBe(false);
  });

  it("RETRY is not settled — that is the whole point of retry", () => {
    expect(
      isStopSettled({
        status: "arrived",
        exceptions: [{ current_state: "resolved", resolution: "retry", actions: [{ type: "verify" }] }],
      })
    ).toBe(false);
  });

  it("rejected and still-open are not settled", () => {
    expect(isStopSettled({ status: "arrived", exceptions: [{ current_state: "rejected", resolution: null }] })).toBe(false);
    expect(isStopSettled({ status: "arrived", exceptions: [{ current_state: "reported", resolution: null }] })).toBe(false);
  });

  it("a DELIVERED stop is never 'settled undelivered'", () => {
    expect(isStopSettled({ ...settled, status: "delivered" })).toBe(false);
  });

  it("no exceptions at all, or an older API that omits the field → not settled", () => {
    // Absent field must degrade to the pre-Q11(a) behaviour, never to "settled".
    expect(isStopSettled({ status: "arrived", exceptions: [] })).toBe(false);
    expect(isStopSettled({ status: "arrived" })).toBe(false);
  });
});

describe("outstandingStops", () => {
  it("drops delivered AND settled stops, keeps the rest in order", () => {
    const stops = [
      { id: "a", status: "delivered" },
      { id: "b", ...settled },
      { id: "c", status: "pending" },
      { id: "d", status: "arrived" },
    ];
    expect(outstandingStops(stops).map((s) => s.id)).toEqual(["c", "d"]);
  });

  it("returns empty when every stop is done one way or the other", () => {
    // The single-drop Q11(a) case: the driver's work is finished even though
    // nothing was delivered.
    expect(outstandingStops([{ id: "a", ...settled }])).toEqual([]);
  });
});
