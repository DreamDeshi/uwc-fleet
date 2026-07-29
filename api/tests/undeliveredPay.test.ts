import { describe, it, expect } from "vitest";
import {
  stopPayEligibility,
  stopEarns,
  payAttributionInstant,
  hasResolvedStopException,
  type PayableStopLike,
} from "../src/services/undeliveredPay";

// R3 Q11(a) "Same rate paid, although not delivered" / (b) "Yes paid".
// The three conditions and the pay instant, branch by branch.

const ARRIVED = new Date("2026-07-29T02:00:00Z"); // 10:00 MYT
const DELIVERED = new Date("2026-07-29T03:00:00Z"); // 11:00 MYT

const stop = (over: Partial<PayableStopLike> = {}): PayableStopLike => ({
  status: "arrived",
  arrived_at: ARRIVED,
  delivered_at: null,
  exceptions: [],
  ...over,
});

const resolved = [{ current_state: "resolved" }];
const rejected = [{ current_state: "rejected" }];
const stillOpen = [{ current_state: "reported" }];

describe("a DELIVERED stop is unaffected", () => {
  it("earns on the normal path and attributes to delivered_at", () => {
    const s = stop({ status: "delivered", delivered_at: DELIVERED });
    expect(stopPayEligibility(s)).toBe("delivered");
    expect(payAttributionInstant(s)).toBe(DELIVERED);
  });

  it("stays 'delivered' even with a resolved exception — never counted twice", () => {
    // A retried stop that eventually WAS delivered carries a resolved
    // exception. It must earn once, on the delivered path.
    const s = stop({ status: "delivered", delivered_at: DELIVERED, exceptions: resolved });
    expect(stopPayEligibility(s)).toBe("delivered");
    expect(payAttributionInstant(s)).toBe(DELIVERED);
  });
});

describe("R3 Q11(a) — reached but undeliverable, admin resolved → PAID", () => {
  it("earns, and attributes to arrived_at", () => {
    const s = stop({ exceptions: resolved });
    expect(stopPayEligibility(s)).toBe("undelivered_paid");
    expect(stopEarns(s)).toBe(true);
    expect(payAttributionInstant(s)).toBe(ARRIVED);
  });

  it("the admin's verify/resolve is what authorises it", () => {
    expect(hasResolvedStopException(stop({ exceptions: resolved }))).toBe(true);
    expect(hasResolvedStopException(stop({ exceptions: rejected }))).toBe(false);
  });
});

describe("R3 Q11(b) — a stop the driver NEVER REACHED earns nothing", () => {
  // "if the lorry breakdown halfway, no incentive" (16 Jul) — the stops he
  // never got to. Arrival is the physical line between (a) and (b); the
  // exception's CATEGORY is deliberately not consulted.
  it("no arrival → unpaid, even with a resolved exception attached", () => {
    const s = stop({ arrived_at: null, exceptions: resolved });
    expect(stopPayEligibility(s)).toBe("unpaid");
    expect(payAttributionInstant(s)).toBeNull();
  });

  it("a pending, never-visited stop earns nothing", () => {
    expect(stopPayEligibility(stop({ status: "pending", arrived_at: null }))).toBe("unpaid");
  });
});

describe("the admin's levers", () => {
  it("REJECTED → unpaid (the explicit denial)", () => {
    const s = stop({ exceptions: rejected });
    expect(stopPayEligibility(s)).toBe("unpaid");
    expect(payAttributionInstant(s)).toBeNull();
  });

  it("still OPEN → unpaid for now (the trip cannot finalize while one is open)", () => {
    expect(stopPayEligibility(stop({ exceptions: stillOpen }))).toBe("unpaid");
  });

  it("arrived with NO exception at all → unpaid", () => {
    // A driver who simply arrives and never delivers or reports earns nothing:
    // nobody adjudicated it.
    expect(stopPayEligibility(stop({ exceptions: [] }))).toBe("unpaid");
    expect(stopPayEligibility(stop({ exceptions: undefined }))).toBe("unpaid");
  });

  it("one resolved among several attached exceptions is enough", () => {
    const s = stop({ exceptions: [{ current_state: "rejected" }, { current_state: "resolved" }] });
    expect(stopPayEligibility(s)).toBe("undelivered_paid");
  });
});

describe("payAttributionInstant is never the admin's clock", () => {
  it("uses the driver's arrival, so an admin's delay cannot move the pay day or rate tier", () => {
    // arrived 10:00 MYT (peak). Whatever time the admin resolves at — possibly
    // days later, possibly after 18:00 — the anchor stays the arrival.
    expect(payAttributionInstant(stop({ exceptions: resolved }))).toBe(ARRIVED);
  });
});
