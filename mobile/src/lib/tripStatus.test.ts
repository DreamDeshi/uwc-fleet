import { describe, it, expect } from "vitest";
import type { TripStatus } from "../types";
import {
  ACTIVE_STATUSES,
  DELIVERED_STATUSES,
  assertNever,
  isAwaitingApproval,
  isDelivered,
} from "./tripStatus";

// Every member of the union, written out. If TripStatus grows, this literal is
// the first thing that should need updating — and the exhaustiveness proofs
// below make that a compile error rather than a silent miss.
const ALL_STATUSES: TripStatus[] = [
  "pending",
  "approved",
  "rejected",
  "assigned",
  "in_progress",
  "pending_approval",
  "completed",
  "cancelled",
];

describe("ACTIVE_STATUSES", () => {
  it("is the in-flight set — and deliberately EXCLUDES pending_approval", () => {
    expect(ACTIVE_STATUSES.sort()).toEqual(
      ["approved", "assigned", "in_progress", "pending"].sort()
    );
    // The regression this file exists to prevent: a delivered-but-unapproved
    // trip is NOT active. It is done driving; only the money is outstanding.
    expect(ACTIVE_STATUSES).not.toContain("pending_approval");
  });
});

describe("DELIVERED_STATUSES", () => {
  it("holds BOTH pending_approval and completed — the goods arrived either way", () => {
    expect(DELIVERED_STATUSES.sort()).toEqual(["completed", "pending_approval"].sort());
  });

  it("REGRESSION: pending_approval is listable — it fell through every filter before", () => {
    // Pre-fix, `=== "completed"` was the Completed filter and the ACTIVE array
    // omitted pending_approval, so a delivered trip appeared under NEITHER tab
    // and was reachable only via "All".
    expect(DELIVERED_STATUSES).toContain("pending_approval");
    expect(ACTIVE_STATUSES).not.toContain("pending_approval");
  });
});

describe("classification is total", () => {
  it("places every status in exactly one of: active, delivered, or terminal", () => {
    const terminal: TripStatus[] = ["rejected", "cancelled"];
    const classified = [...ACTIVE_STATUSES, ...DELIVERED_STATUSES, ...terminal];

    // No status is both in-flight and delivered.
    expect(new Set(classified).size).toBe(classified.length);
    // No status is left unclassified — this is what broke when item 9 landed.
    expect(classified.sort()).toEqual(ALL_STATUSES.slice().sort());
  });
});

describe("isDelivered / isAwaitingApproval", () => {
  it("treats pending_approval as delivered but NOT as payable", () => {
    expect(isDelivered("pending_approval")).toBe(true);
    expect(isAwaitingApproval("pending_approval")).toBe(true);

    expect(isDelivered("completed")).toBe(true);
    expect(isAwaitingApproval("completed")).toBe(false); // approved → payable
  });

  it("is false for everything still in flight or terminal", () => {
    for (const s of ["pending", "approved", "assigned", "in_progress"] as TripStatus[]) {
      expect(isDelivered(s)).toBe(false);
      expect(isAwaitingApproval(s)).toBe(false);
    }
    for (const s of ["rejected", "cancelled"] as TripStatus[]) {
      expect(isDelivered(s)).toBe(false);
      expect(isAwaitingApproval(s)).toBe(false);
    }
  });
});

describe("assertNever", () => {
  it("throws with context when an off-union value arrives at runtime", () => {
    // e.g. an older client reading a status a newer server invented.
    expect(() => assertNever("archived" as never, "TripStatus")).toThrow(/Unhandled TripStatus/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// COMPILE-TIME PROOFS
//
// These assert things vitest cannot: that the BUILD fails. They carry no
// runtime assertions — `tsc --noEmit` is the test runner here. Each
// `@ts-expect-error` is itself checked: if the error it expects did NOT occur,
// tsc reports the directive as unused and the build fails. So a broken guard
// cannot pass silently.
// ───────────────────────────────────────────────────────────────────────────

// PROOF 1 — a Record<TripStatus, …> missing a key does not compile. This is the
// mechanism that makes the derived arrays above safe, and the reason an array
// literal (`const ACTIVE: TripStatus[] = [...]`) was NOT safe: TypeScript never
// exhaustiveness-checks an array literal, so the old code compiled clean while
// silently dropping pending_approval.
// @ts-expect-error — `completed` is missing; an incomplete decision map must fail.
const _incompleteMap: Record<TripStatus, boolean> = {
  pending: false,
  approved: false,
  rejected: false,
  assigned: false,
  in_progress: false,
  pending_approval: false,
  cancelled: false,
};
void _incompleteMap;

// PROOF 2 — THE ONE THE OWNER ASKED FOR: adding a 9th status must fail to
// compile at the decision maps, not produce a wrong answer at runtime. We
// cannot widen the real union from a test, so we widen a local alias and prove
// that a map covering only today's 8 no longer satisfies it.
type NinthStatus = TripStatus | "archived";
// @ts-expect-error — `archived` is unhandled; a new status MUST break the build.
const _ninthStatusMustNotCompile: Record<NinthStatus, boolean> = {
  pending: false,
  approved: false,
  rejected: false,
  assigned: false,
  in_progress: false,
  pending_approval: false,
  completed: false,
  cancelled: false,
};
void _ninthStatusMustNotCompile;

// PROOF 3 — assertNever rejects a still-live union member. If a switch forgets a
// case, the value reaching the guard is not `never` and the call fails to
// compile — which is exactly how the missing pending_approval case gets caught.
// Never invoked; it exists to be type-checked.
function _assertNeverRejectsLiveMember(status: TripStatus) {
  // @ts-expect-error — TripStatus is not `never`, so this must not compile.
  return assertNever(status, "TripStatus");
}
void _assertNeverRejectsLiveMember;
