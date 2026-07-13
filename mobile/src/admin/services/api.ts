// The in-app admin rides the SAME authenticated axios client as the driver /
// requestor screens — one login, one token pair, one refresh interceptor
// (services/api.ts). This module just re-exports it for the ported admin
// hooks plus the one admin-only helper the shared client doesn't have.
import type { AxiosError } from "axios";
import type { ApiErrorShape, SchedulingConflictInfo } from "../types";

export { api, apiErrorMessage, apiErrorCode } from "../../services/api";

// Scheduling-conflict trips returned on a 409 SCHEDULING_CONFLICT, or []
// otherwise (manual assign/reassign override flow — web admin parity).
export function apiErrorConflicts(err: unknown): SchedulingConflictInfo[] {
  return (err as AxiosError<ApiErrorShape>)?.response?.data?.error?.conflicts ?? [];
}
