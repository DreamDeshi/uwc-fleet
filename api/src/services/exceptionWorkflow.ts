import { ApiError } from "../lib/apiError";

/**
 * PURE state machine + guards for the failed-delivery / exception workflow
 * (Phase 1). No database, no Prisma — factored out (same discipline as
 * tripCompletion.ts / incentiveEngine.ts) so the money-adjacent transition
 * logic is unit-testable in plain node.
 *
 * The exception is an append-only aggregate: an immutable TripException header,
 * an ExceptionAction log, and ExceptionEvidence rows. The header's
 * `current_state` is a DERIVED projection of the latest action — this module is
 * the single source of truth for "given the current state and an action, what is
 * the next state, and does it CLOSE the exception".
 *
 * MONEY / CAPACITY BOUNDARY (frozen): Phase 1 EXECUTES only `resume` and `retry`
 * — both keep Trip.status = in_progress and change no pay, capacity, cancellation
 * or reschedule/reassignment. The other resolutions (reschedule, reassign_*,
 * return_cargo, cancel) are refused here (assertResolutionExecutable) so no
 * frozen boundary is ever crossed by this workflow.
 */

export type ExceptionStateT = "reported" | "more_evidence" | "verified" | "rejected" | "resolved";
export type ExceptionActionTypeT =
  | "report"
  | "request_more_evidence"
  | "verify"
  | "reject"
  | "resume"
  | "resolve";
export type ExceptionResolutionT =
  | "resume"
  | "retry"
  | "reschedule"
  | "reassign_lorry"
  | "reassign_driver"
  | "return_cargo"
  | "cancel";

// Non-terminal states — the exception is still OPEN (it holds Trip.open_exception_id).
const OPEN_STATES: ReadonlySet<ExceptionStateT> = new Set(["reported", "more_evidence", "verified"]);

export function isOpenState(state: ExceptionStateT): boolean {
  return OPEN_STATES.has(state);
}

// The SOURCE states each admin/driver action is allowed from. `report` is
// creation-only (never a transition on an existing row).
const ALLOWED_FROM: Record<Exclude<ExceptionActionTypeT, "report">, readonly ExceptionStateT[]> = {
  request_more_evidence: ["reported"],
  verify: ["reported", "more_evidence"],
  reject: ["reported", "more_evidence", "verified"],
  resume: ["reported", "more_evidence", "verified"],
  resolve: ["reported", "verified"], // Phase 1: retry only
};

export interface TransitionResult {
  state: ExceptionStateT;
  /** true → the exception becomes terminal (closed): clear Trip.open_exception_id. */
  closes: boolean;
  /** Set for resume/resolve — the recorded resolution. */
  resolution?: ExceptionResolutionT;
}

/**
 * Given the current header state and an action, return the next state (or throw
 * 409 INVALID_TRANSITION). `resolveWith` is required for `resolve` (Phase 1 must
 * be `retry`); ignored otherwise.
 */
export function nextExceptionState(
  current: ExceptionStateT,
  action: Exclude<ExceptionActionTypeT, "report">,
  resolveWith?: ExceptionResolutionT
): TransitionResult {
  if (!isOpenState(current)) {
    throw new ApiError(409, "EXCEPTION_CLOSED", "This exception is already closed.");
  }
  if (!ALLOWED_FROM[action].includes(current)) {
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      `Cannot ${action} an exception in state "${current}".`
    );
  }
  switch (action) {
    case "request_more_evidence":
      return { state: "more_evidence", closes: false };
    case "verify":
      return { state: "verified", closes: false };
    case "reject":
      return { state: "rejected", closes: true };
    case "resume":
      return { state: "resolved", closes: true, resolution: "resume" };
    case "resolve":
      assertResolutionExecutable(resolveWith);
      return { state: "resolved", closes: true, resolution: resolveWith };
  }
}

/**
 * The resolution transition the DERIVED header state reflects after a driver
 * adds evidence: a stop that was awaiting more evidence returns to `reported`
 * (back in the admin's review queue). Any other state is unchanged. Evidence is
 * only accepted while the exception is OPEN.
 */
export function stateAfterEvidence(current: ExceptionStateT): ExceptionStateT {
  if (!isOpenState(current)) {
    throw new ApiError(409, "EXCEPTION_CLOSED", "This exception is closed — no more evidence can be added.");
  }
  return current === "more_evidence" ? "reported" : current;
}

/**
 * Phase-1 execution gate: only `resume` and `retry` may actually run — they keep
 * the trip in_progress and touch no pay/capacity. The remaining resolutions are
 * deliberately deferred (they would cross the frozen cancellation / reschedule /
 * reassignment execution boundary), so the route refuses them for now.
 */
export function assertResolutionExecutable(resolution: ExceptionResolutionT | undefined): asserts resolution is "retry" {
  if (resolution === "retry") return;
  if (resolution === "resume") {
    // resume has its own endpoint; it should not arrive via /resolve.
    throw new ApiError(400, "USE_RESUME_ENDPOINT", "Use the resume action to continue the trip.");
  }
  throw new ApiError(
    400,
    "RESOLUTION_NOT_AVAILABLE",
    "Only Resume and Retry are available in this phase; reschedule, reassign, return and cancel are not yet enabled."
  );
}

// The exception categories a DRIVER may report (all five — Mr. Teh's A–E).
export const EXCEPTION_CATEGORIES = [
  "customer_site",
  "truck",
  "cargo",
  "external",
  "documentation",
] as const;
export type ExceptionCategoryT = (typeof EXCEPTION_CATEGORIES)[number];

/**
 * A driver may open an exception only on THEIR OWN trip that is actually out
 * (in_progress), and only one open exception per trip. The one-open guard is
 * ENFORCED atomically at the DB layer (CAS on Trip.open_exception_id); this pure
 * guard covers the cheap up-front checks so they are unit-testable and produce
 * the canonical errors.
 */
export function assertCanReport(
  trip: { status: string; driver_id: string | null },
  actorId: string
): void {
  if (trip.driver_id !== actorId) {
    throw new ApiError(403, "FORBIDDEN", "You are not the driver assigned to this trip.");
  }
  if (trip.status !== "in_progress") {
    throw new ApiError(
      409,
      "TRIP_NOT_IN_PROGRESS",
      "An exception can only be reported while the trip is in progress."
    );
  }
}

/** Optimistic-concurrency check: reject a stale write (client's version != current). */
export function assertVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== current) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "This exception was updated by someone else. Refresh and try again."
    );
  }
}
