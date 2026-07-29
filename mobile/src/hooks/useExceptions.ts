import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { exceptionsEnabled } from "../lib/featureFlags";
import {
  getTripException,
  listOpenExceptions,
  verifyException,
  requestMoreEvidence,
  rejectException,
  resumeException,
  selfResumeException,
  resolveException,
  addExceptionEvidence,
  type AdminActionInput,
  type ExceptionFull,
  type ExceptionRedacted,
  type ExceptionListRow,
} from "../services/exceptions";
import type { PickedPhoto } from "../lib/photo";

// React Query wiring for the exception workflow. Every query is gated on the
// feature flag, so with the feature OFF nothing is ever fetched.

export function useTripException(tripId: string | undefined, enabled = true) {
  return useQuery<ExceptionFull | ExceptionRedacted | null>({
    queryKey: ["exception", tripId],
    queryFn: () => getTripException(tripId as string),
    enabled: exceptionsEnabled() && enabled && !!tripId,
    refetchInterval: exceptionsEnabled() && enabled ? 20_000 : false,
  });
}

export function useOpenExceptions(enabled = true) {
  return useQuery<ExceptionListRow[]>({
    queryKey: ["exceptions", "open"],
    queryFn: listOpenExceptions,
    enabled: exceptionsEnabled() && enabled,
    refetchInterval: exceptionsEnabled() && enabled ? 20_000 : false,
  });
}

/** After any successful mutation, re-sync the detail, the open list and the trip. */
function useExceptionInvalidate() {
  const qc = useQueryClient();
  return (tripId: string) => {
    qc.invalidateQueries({ queryKey: ["exception", tripId] });
    qc.invalidateQueries({ queryKey: ["exceptions", "open"] });
    qc.invalidateQueries({ queryKey: ["trip", tripId] });
    qc.invalidateQueries({ queryKey: ["trips"] });
  };
}

type AdminFn = (tripId: string, exId: string, input: AdminActionInput) => Promise<ExceptionFull>;

/** One mutation covering every Phase-1 admin transition. `resolution` is passed
 *  through for retry; all others ignore it. Conflict handling (409) is done at
 *  the call site by refetching + surfacing the server message. */
export function useAdminExceptionAction() {
  const invalidate = useExceptionInvalidate();
  return useMutation({
    mutationFn: async (vars: {
      tripId: string;
      exId: string;
      action: "verify" | "request-more-evidence" | "reject" | "resume" | "resolve";
      input: AdminActionInput;
      resolution?: string;
    }) => {
      if (vars.action === "resolve") {
        return resolveException(vars.tripId, vars.exId, { ...vars.input, resolution: vars.resolution ?? "retry" });
      }
      const fn: AdminFn = { verify: verifyException, "request-more-evidence": requestMoreEvidence, reject: rejectException, resume: resumeException }[vars.action];
      return fn(vars.tripId, vars.exId, vars.input);
    },
    onSuccess: (_data, vars) => invalidate(vars.tripId),
  });
}

/** Driver self-resume — unblocks HIS OWN trip; never a pay decision. */
export function useSelfResumeException() {
  const invalidate = useExceptionInvalidate();
  return useMutation({
    mutationFn: (vars: { tripId: string; exId: string; input: AdminActionInput }) =>
      selfResumeException(vars.tripId, vars.exId, vars.input),
    onSuccess: (_data, vars) => invalidate(vars.tripId),
  });
}

/** Driver evidence resubmission (when the admin asked for more). */
export function useAddExceptionEvidence() {
  const invalidate = useExceptionInvalidate();
  return useMutation({
    mutationFn: (vars: { tripId: string; exId: string; photo: PickedPhoto; clientEvidenceId: string; capturedClientAt: string }) =>
      addExceptionEvidence(vars.tripId, vars.exId, { photo: vars.photo, clientEvidenceId: vars.clientEvidenceId, capturedClientAt: vars.capturedClientAt }),
    onSuccess: (_data, vars) => invalidate(vars.tripId),
  });
}
