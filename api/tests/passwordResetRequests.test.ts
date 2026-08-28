import { describe, it, expect } from "vitest";
import {
  PASSWORD_RESET_REQUEST_TTL_MS,
  claimablePasswordResetRequestWhere,
  effectivePasswordResetStatus,
  isPasswordResetRequestExpired,
} from "../src/lib/passwordResetRequests";

describe("isPasswordResetRequestExpired / effectivePasswordResetStatus", () => {
  const now = new Date("2026-08-28T12:00:00Z");

  it("a fresh pending request is not expired", () => {
    const r = { status: "pending" as const, requested_at: new Date(now.getTime() - 60_000) };
    expect(isPasswordResetRequestExpired(r, now)).toBe(false);
    expect(effectivePasswordResetStatus(r, now)).toBe("pending");
  });

  it("a pending request past the TTL reads as expired", () => {
    const r = { status: "pending" as const, requested_at: new Date(now.getTime() - PASSWORD_RESET_REQUEST_TTL_MS - 1) };
    expect(isPasswordResetRequestExpired(r, now)).toBe(true);
    expect(effectivePasswordResetStatus(r, now)).toBe("expired");
  });

  it("exactly at the TTL boundary is NOT yet expired (boundary is exclusive)", () => {
    const r = { status: "pending" as const, requested_at: new Date(now.getTime() - PASSWORD_RESET_REQUEST_TTL_MS) };
    expect(isPasswordResetRequestExpired(r, now)).toBe(false);
  });

  it("an ALREADY-RESOLVED request is never 'expired', no matter how old", () => {
    // The TTL only ever governs an untouched pending row — approved/dismissed
    // rows are terminal and must not flip to a different label with age.
    const ancient = new Date(now.getTime() - PASSWORD_RESET_REQUEST_TTL_MS * 100);
    expect(effectivePasswordResetStatus({ status: "approved", requested_at: ancient }, now)).toBe("approved");
    expect(effectivePasswordResetStatus({ status: "dismissed", requested_at: ancient }, now)).toBe("dismissed");
  });
});

describe("claimablePasswordResetRequestWhere (the approve/dismiss CAS)", () => {
  const now = new Date("2026-08-28T12:00:00Z");

  it("requires status=pending", () => {
    expect(claimablePasswordResetRequestWhere(now).status).toBe("pending");
  });

  it("the requested_at floor is exactly `now - TTL` — a request requested right at the floor is still claimable", () => {
    const where = claimablePasswordResetRequestWhere(now);
    const floor = where.requested_at.gte;
    expect(floor.getTime()).toBe(now.getTime() - PASSWORD_RESET_REQUEST_TTL_MS);
  });
});
