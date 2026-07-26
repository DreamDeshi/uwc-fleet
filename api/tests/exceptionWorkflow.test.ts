import { describe, it, expect } from "vitest";
import {
  nextExceptionState,
  stateAfterEvidence,
  isOpenState,
  assertResolutionExecutable,
  assertCanReport,
  assertVersion,
  type ExceptionStateT,
} from "../src/services/exceptionWorkflow";
import { ApiError } from "../src/lib/apiError";

/** Assert a thunk throws an ApiError with a specific code + status. */
function expectApiError(fn: () => unknown, code: string, status?: number) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    if (status !== undefined) expect((err as ApiError).statusCode).toBe(status);
    return;
  }
  throw new Error(`expected ApiError(${code}) but nothing was thrown`);
}

describe("exceptionWorkflow — pure state machine", () => {
  it("open vs closed states", () => {
    expect(isOpenState("reported")).toBe(true);
    expect(isOpenState("more_evidence")).toBe(true);
    expect(isOpenState("verified")).toBe(true);
    expect(isOpenState("resolved")).toBe(false);
    expect(isOpenState("rejected")).toBe(false);
  });

  it("request_more_evidence: reported → more_evidence (open)", () => {
    expect(nextExceptionState("reported", "request_more_evidence")).toEqual({
      state: "more_evidence",
      closes: false,
    });
  });

  it("verify: reported/more_evidence → verified (open)", () => {
    expect(nextExceptionState("reported", "verify").state).toBe("verified");
    expect(nextExceptionState("more_evidence", "verify").state).toBe("verified");
  });

  it("reject: → rejected and CLOSES", () => {
    const t = nextExceptionState("verified", "reject");
    expect(t.state).toBe("rejected");
    expect(t.closes).toBe(true);
  });

  it("resume: → resolved(resume) and CLOSES, from any open state", () => {
    for (const s of ["reported", "more_evidence", "verified"] as ExceptionStateT[]) {
      const t = nextExceptionState(s, "resume");
      expect(t).toEqual({ state: "resolved", closes: true, resolution: "resume" });
    }
  });

  it("resolve(retry): → resolved(retry) and CLOSES", () => {
    const t = nextExceptionState("verified", "resolve", "retry");
    expect(t).toEqual({ state: "resolved", closes: true, resolution: "retry" });
  });

  it("resolve with a non-executable resolution is refused (frozen boundary)", () => {
    for (const r of ["reschedule", "reassign_lorry", "reassign_driver", "return_cargo", "cancel"] as const) {
      expectApiError(() => nextExceptionState("verified", "resolve", r), "RESOLUTION_NOT_AVAILABLE", 400);
    }
  });

  it("resolve via the resume value is bounced to the resume endpoint", () => {
    expectApiError(() => nextExceptionState("verified", "resolve", "resume"), "USE_RESUME_ENDPOINT", 400);
  });

  it("request_more_evidence is only valid from reported", () => {
    expectApiError(() => nextExceptionState("verified", "request_more_evidence"), "INVALID_TRANSITION", 409);
    expectApiError(() => nextExceptionState("more_evidence", "request_more_evidence"), "INVALID_TRANSITION", 409);
  });

  it("any action on a closed exception → EXCEPTION_CLOSED", () => {
    for (const s of ["resolved", "rejected"] as ExceptionStateT[]) {
      expectApiError(() => nextExceptionState(s, "verify"), "EXCEPTION_CLOSED", 409);
      expectApiError(() => nextExceptionState(s, "resume"), "EXCEPTION_CLOSED", 409);
    }
  });

  it("stateAfterEvidence: more_evidence → reported (re-review); others unchanged", () => {
    expect(stateAfterEvidence("more_evidence")).toBe("reported");
    expect(stateAfterEvidence("reported")).toBe("reported");
    expect(stateAfterEvidence("verified")).toBe("verified");
    expectApiError(() => stateAfterEvidence("resolved"), "EXCEPTION_CLOSED", 409);
  });

  it("assertResolutionExecutable narrows to retry", () => {
    expect(() => assertResolutionExecutable("retry")).not.toThrow();
  });
});

describe("exceptionWorkflow — report guard + concurrency", () => {
  it("only the assigned driver may report", () => {
    expectApiError(() => assertCanReport({ status: "in_progress", driver_id: "d1" }, "d2"), "FORBIDDEN", 403);
  });

  it("report requires the trip to be in_progress", () => {
    expectApiError(() => assertCanReport({ status: "assigned", driver_id: "d1" }, "d1"), "TRIP_NOT_IN_PROGRESS", 409);
    expect(() => assertCanReport({ status: "in_progress", driver_id: "d1" }, "d1")).not.toThrow();
  });

  it("assertVersion rejects a stale write, allows a matching or omitted one", () => {
    expect(() => assertVersion(3, 3)).not.toThrow();
    expect(() => assertVersion(3, undefined)).not.toThrow();
    expectApiError(() => assertVersion(3, 2), "VERSION_CONFLICT", 409);
  });
});
