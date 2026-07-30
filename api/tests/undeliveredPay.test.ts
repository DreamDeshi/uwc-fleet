import { describe, it, expect } from "vitest";
import {
  stopPayEligibility,
  stopEarns,
  stopPayInstant,
  hasResolvedStopException,
  SETTLED_UNDELIVERED_WHERE,
  type PayableStopLike,
} from "../src/services/undeliveredPay";

// R3 Q11(a) "Same rate paid, although not delivered" / (b) "Yes paid".
// The three conditions and the pay instant, branch by branch.

const ARRIVED = new Date("2026-07-29T02:00:00Z"); // 10:00 MYT
const DELIVERED = new Date("2026-07-29T03:00:00Z"); // 11:00 MYT
const LATER = new Date("2026-07-29T09:00:00Z"); // 17:00 MYT

const stop = (over: Partial<PayableStopLike> = {}): PayableStopLike => ({
  status: "arrived",
  arrived_at: ARRIVED,
  delivered_at: null,
  exceptions: [],
  ...over,
});

// The four ways an exception can end up in the DB.
const verifiedThenResumed = [
  { current_state: "resolved", resolution: "resume", actions: [{ type: "report" }, { type: "verify" }, { type: "resume" }] },
];
const resumedWithoutVerify = [
  // "Resume trip" straight from `reported` — the admin unblocking a stranded
  // truck. Same current_state, NOT an adjudication.
  { current_state: "resolved", resolution: "resume", actions: [{ type: "report" }, { type: "resume" }] },
];
const verifiedThenRetried = [
  { current_state: "resolved", resolution: "retry", actions: [{ type: "report" }, { type: "verify" }, { type: "resolve" }] },
];
const rejected = [
  { current_state: "rejected", resolution: null, actions: [{ type: "report" }, { type: "reject" }] },
];
const stillOpen = [{ current_state: "reported", resolution: null, actions: [{ type: "report" }] }];
const verifiedStillOpen = [
  { current_state: "verified", resolution: null, actions: [{ type: "report" }, { type: "verify" }] },
];

describe("a DELIVERED stop is unaffected", () => {
  it("earns on the normal path and attributes to delivered_at", () => {
    const s = stop({ status: "delivered", delivered_at: DELIVERED });
    expect(stopPayEligibility(s)).toBe("delivered");
    expect(stopPayInstant(s)).toBe(DELIVERED);
  });

  it("stays 'delivered' even with a settled exception — never counted twice", () => {
    // A retried stop that eventually WAS delivered carries a closed exception.
    // It must earn once, on the delivered path.
    const s = stop({ status: "delivered", delivered_at: DELIVERED, exceptions: verifiedThenResumed });
    expect(stopPayEligibility(s)).toBe("delivered");
    expect(stopPayInstant(s)).toBe(DELIVERED);
  });
});

describe("R3 Q11(a) — reached, verified, and resumed → PAID", () => {
  it("earns, and attributes to arrived_at", () => {
    const s = stop({ exceptions: verifiedThenResumed });
    expect(stopPayEligibility(s)).toBe("undelivered_paid");
    expect(stopEarns(s)).toBe(true);
    expect(stopPayInstant(s)).toBe(ARRIVED);
  });
});

describe("R3 Q11(b) — a stop the driver NEVER REACHED earns nothing", () => {
  // "if the lorry breakdown halfway, no incentive" (16 Jul) — the stops he
  // never got to. Arrival is the physical line between (a) and (b); the
  // exception's CATEGORY is deliberately not consulted.
  it("no arrival → unpaid, even with a fully adjudicated exception attached", () => {
    const s = stop({ arrived_at: null, exceptions: verifiedThenResumed });
    expect(stopPayEligibility(s)).toBe("unpaid");
    expect(stopPayInstant(s)).toBeNull();
  });

  it("a pending, never-visited stop earns nothing", () => {
    expect(stopPayEligibility(stop({ status: "pending", arrived_at: null }))).toBe("unpaid");
  });
});

// ── The two halves of the adjudication ──────────────────────────────────────
// `current_state: "resolved"` alone is NOT a pay decision: it is produced by
// two different admin buttons, both reachable from `reported` with no Verify.
describe("VERIFY is required — a bare Resume pays nothing", () => {
  it("resume WITHOUT a verify action → unpaid", () => {
    // The concrete failure this guards: a driver reports `truck` (breakdown) at
    // Ipoh, the category defaults to attaching to his CURRENT stop, and an
    // admin taps Resume to get the truck moving again. Under a
    // current_state-only rule that silently paid full Ipoh zone points.
    const s = stop({ exceptions: resumedWithoutVerify });
    expect(stopPayEligibility(s)).toBe("unpaid");
    expect(stopPayInstant(s)).toBeNull();
    expect(hasResolvedStopException(s)).toBe(false);
  });

  it("verify alone, exception still OPEN → unpaid for now", () => {
    // The trip cannot finalize while an exception is open, so nothing pays yet.
    expect(stopPayEligibility(stop({ exceptions: verifiedStillOpen }))).toBe("unpaid");
  });
});

describe("RETRY settles nothing — the stop is still outstanding", () => {
  it("verified then RETRIED → unpaid", () => {
    // "Retry" means go back and try again. Settling here finalized the trip
    // under the driver, so his later real delivery was rejected as
    // TRIP_NOT_ACTIVE — and the mobile outbox swallows that code as success.
    const s = stop({ exceptions: verifiedThenRetried });
    expect(stopPayEligibility(s)).toBe("unpaid");
    expect(hasResolvedStopException(s)).toBe(false);
  });

  it("retry then an actual delivery pays once, on the delivered path", () => {
    const s = stop({ status: "delivered", delivered_at: LATER, exceptions: verifiedThenRetried });
    expect(stopPayEligibility(s)).toBe("delivered");
    expect(stopPayInstant(s)).toBe(LATER);
  });
});

describe("the admin's levers", () => {
  it("REJECTED → unpaid (the explicit denial)", () => {
    const s = stop({ exceptions: rejected });
    expect(stopPayEligibility(s)).toBe("unpaid");
    expect(stopPayInstant(s)).toBeNull();
  });

  it("still OPEN → unpaid for now", () => {
    expect(stopPayEligibility(stop({ exceptions: stillOpen }))).toBe("unpaid");
  });

  it("arrived with NO exception at all → unpaid", () => {
    // A driver who simply arrives and never delivers or reports earns nothing:
    // nobody adjudicated it.
    expect(stopPayEligibility(stop({ exceptions: [] }))).toBe("unpaid");
    expect(stopPayEligibility(stop({ exceptions: undefined }))).toBe("unpaid");
  });

  it("one fully-adjudicated exception among several is enough", () => {
    const s = stop({ exceptions: [...rejected, ...verifiedThenResumed] });
    expect(stopPayEligibility(s)).toBe("undelivered_paid");
  });

  it("does NOT mix and match across separate exceptions", () => {
    // A verify on one exception must not authorise a DIFFERENT exception's
    // resume. Both halves have to live on the same row.
    const s = stop({ exceptions: [...verifiedStillOpen, ...resumedWithoutVerify] });
    expect(stopPayEligibility(s)).toBe("unpaid");
  });
});

describe("stopPayInstant is never the admin's clock", () => {
  it("uses the driver's arrival, so an admin's delay cannot move the pay day or rate tier", () => {
    // arrived 10:00 MYT (peak). Whatever time the admin verifies/resumes at —
    // possibly days later, possibly after 18:00 — the anchor stays the arrival.
    expect(stopPayInstant(stop({ exceptions: verifiedThenResumed }))).toBe(ARRIVED);
  });

  it("falls back for the legacy delivered-with-null-delivered_at anomaly", () => {
    // Real rows (/reports/attention surfaces them). Returning null here would
    // make finalization drop the stop and silently zero a real drop's pay.
    const s = stop({ status: "delivered", delivered_at: null });
    expect(stopPayInstant(s, LATER)).toBe(LATER);
    expect(stopPayInstant(s)).toBeNull(); // no fallback offered → caller decides
  });
});

describe("the SQL predicate and the in-memory rule are the same rule", () => {
  it("SETTLED_UNDELIVERED_WHERE requires verify AND resume, not just resolved", () => {
    // If these ever drift, the finalizer pays a set of stops the day ledger
    // does not count (or vice versa) — the shape of the old proposal-vs-paid
    // bug. Asserted structurally so a careless widening fails here first.
    expect(SETTLED_UNDELIVERED_WHERE).toEqual({
      status: { not: "delivered" },
      arrived_at: { not: null },
      exceptions: {
        some: {
          current_state: "resolved",
          resolution: "resume",
          actions: { some: { type: "verify" } },
        },
      },
    });
  });
});

describe("a stop carrying SEVERAL exceptions", () => {
  // Reachable since migration 20260730120000_relax_one_open_exception_per_trip
  // dropped the one-OPEN-exception-per-trip index: a driver who continues past
  // one report can file another, including on the same stop.
  //
  // The rule is `some`, on BOTH sides (SETTLED_UNDELIVERED_WHERE above and
  // isStopSettled here), which makes settlement a BOOLEAN PER STOP. That is the
  // property that stops the relaxation turning into double pay: a stop is
  // settled or it is not, however many exceptions it accumulated.

  it("two settled exceptions still make ONE settled stop", () => {
    const s = stop({ exceptions: [...verifiedThenResumed, ...verifiedThenResumed] });
    expect(stopPayEligibility(s)).toBe("undelivered_paid");
    expect(stopEarns(s)).toBe(true);
    // The pay instant is the ARRIVAL, unchanged — it cannot be doubled or moved
    // by a second report, because it is a property of the stop, not the report.
    expect(stopPayInstant(s)).toEqual(ARRIVED);
  });

  it("settles when only ONE of several is adjudicated", () => {
    // Deliberate: one admin decision of "genuine failed delivery, not going
    // back" settles the stop. A second report still open alongside it does not
    // withhold pay the office has already granted.
    expect(stopPayEligibility(stop({ exceptions: [...stillOpen, ...verifiedThenResumed] }))).toBe("undelivered_paid");
    expect(stopPayEligibility(stop({ exceptions: [...verifiedThenResumed, ...stillOpen] }))).toBe("undelivered_paid");
  });

  it("a rejected report alongside a settled one does not cancel the pay", () => {
    expect(stopPayEligibility(stop({ exceptions: [...rejected, ...verifiedThenResumed] }))).toBe("undelivered_paid");
  });

  it("several UNadjudicated reports earn nothing", () => {
    expect(stopPayEligibility(stop({ exceptions: [...stillOpen, ...stillOpen] }))).toBe("unpaid");
    expect(stopPayEligibility(stop({ exceptions: [...stillOpen, ...verifiedStillOpen] }))).toBe("unpaid");
    expect(stopPayEligibility(stop({ exceptions: [...rejected, ...verifiedThenRetried] }))).toBe("unpaid");
  });

  it("a DELIVERED stop still earns on the delivered path, whatever it accumulated", () => {
    // Condition 1 (not delivered) is what stops a retried-then-delivered stop
    // being counted twice; extra exceptions must not change that.
    const s = stop({
      status: "delivered",
      delivered_at: DELIVERED,
      exceptions: [...verifiedThenResumed, ...verifiedThenResumed],
    });
    expect(stopPayEligibility(s)).toBe("delivered");
    expect(stopPayInstant(s)).toEqual(DELIVERED);
  });
});
