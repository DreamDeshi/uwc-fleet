import { describe, it, expect } from "vitest";
import { isStopSettled, outstandingStops } from "./stopSettled";

/**
 * The client-side mirror of api/src/services/undeliveredPay.ts. If these two
 * drift, the driver is offered a POD button for a stop the office already
 * closed and paid — or, the other way, a stop he still has to deliver quietly
 * disappears from his rail.
 */

const ARRIVED = "2026-07-29T02:00:00.000Z";

const settled = {
  status: "arrived",
  arrived_at: ARRIVED,
  exceptions: [
    { current_state: "resolved", resolution: "resume", actions: [{ type: "verify" }] },
  ],
};

describe("isStopSettled", () => {
  it("verify + resume → settled (nothing left for the driver)", () => {
    expect(isStopSettled(settled)).toBe(true);
  });

  it("NEVER REACHED (no arrival) is NOT settled, however fully adjudicated - Q11(b)", () => {
    // "if the lorry breakdown halfway, no incentive" — the stops he never got
    // to. The report sheet attaches a `truck`/`external` exception to the
    // driver's NEXT stop, which is pending with no arrival, so without this the
    // stop vanished from his rail while the server still counted it
    // outstanding: unfinishable trip, undelivered consignee, RM66 short.
    expect(isStopSettled({ ...settled, arrived_at: null })).toBe(false);
    expect(isStopSettled({ status: "pending", exceptions: settled.exceptions })).toBe(false);
  });

  it("a bare resume with NO verify is NOT settled", () => {
    // An admin unblocking a stuck truck has not adjudicated anything, and the
    // server pays nothing — so the stop is still the driver's to deliver.
    expect(
      isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [{ current_state: "resolved", resolution: "resume", actions: [] }] })
    ).toBe(false);
  });

  it("RETRY is not settled — that is the whole point of retry", () => {
    expect(
      isStopSettled({
        status: "arrived",
        arrived_at: ARRIVED,
        exceptions: [{ current_state: "resolved", resolution: "retry", actions: [{ type: "verify" }] }],
      })
    ).toBe(false);
  });

  it("rejected and still-open are not settled", () => {
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [{ current_state: "rejected", resolution: null }] })).toBe(false);
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [{ current_state: "reported", resolution: null }] })).toBe(false);
  });

  it("a DELIVERED stop is never 'settled undelivered'", () => {
    expect(isStopSettled({ ...settled, status: "delivered" })).toBe(false);
  });

  it("no exceptions at all, or an older API that omits the field → not settled", () => {
    // Absent field must degrade to the pre-Q11(a) behaviour, never to "settled".
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [] })).toBe(false);
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED })).toBe(false);
  });
});

describe("outstandingStops", () => {
  it("drops delivered AND settled stops, keeps the rest in order", () => {
    const stops = [
      { id: "a", status: "delivered" },
      { id: "b", ...settled },
      { id: "c", status: "pending", arrived_at: null },
      { id: "d", status: "arrived", arrived_at: ARRIVED },
    ];
    expect(outstandingStops(stops).map((s) => s.id)).toEqual(["c", "d"]);
  });

  it("returns empty when every stop is done one way or the other", () => {
    // The single-drop Q11(a) case: the driver's work is finished even though
    // nothing was delivered.
    expect(outstandingStops([{ id: "a", ...settled }])).toEqual([]);
  });
});

describe("a stop carrying SEVERAL exceptions", () => {
  // The api side gained equivalent cases in api/tests/undeliveredPay.test.ts.
  // These two predicates are asserted to be the same rule only by keeping the
  // parallel tests in step, so the mobile mirror must move with it.
  //
  // Reachable since migration 20260730120000 dropped the one-OPEN-per-trip
  // index: a driver who continues past one report can file another, including
  // on the same stop.
  const SETTLED = { current_state: "resolved", resolution: "resume", actions: [{ type: "verify" }] };
  const OPEN = { current_state: "reported", resolution: null, actions: [{ type: "report" }] };
  const REJECTED = { current_state: "rejected", resolution: null, actions: [{ type: "reject" }] };

  it("two settled exceptions still make ONE settled stop", () => {
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [SETTLED, SETTLED] })).toBe(true);
  });

  it("settles when only ONE of several is adjudicated, in either order", () => {
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [OPEN, SETTLED] })).toBe(true);
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [SETTLED, OPEN] })).toBe(true);
  });

  it("several UNadjudicated reports leave the stop outstanding", () => {
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [OPEN, OPEN] })).toBe(false);
    expect(isStopSettled({ status: "arrived", arrived_at: ARRIVED, exceptions: [OPEN, REJECTED] })).toBe(false);
  });

  it("a settled stop with a second open report is NOT outstanding", () => {
    // The driver's rail must not re-show a stop the office has already paid for
    // just because he filed another report about it.
    const stops = [
      { id: "a", status: "arrived", arrived_at: ARRIVED, exceptions: [SETTLED, OPEN] },
      { id: "b", status: "arrived", arrived_at: ARRIVED, exceptions: [OPEN] },
    ];
    expect(outstandingStops(stops).map((s) => s.id)).toEqual(["b"]);
  });
});
