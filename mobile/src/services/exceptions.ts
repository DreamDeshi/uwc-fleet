import { api } from "./api";
import { appendPhoto, UPLOAD_HEADERS } from "../hooks/queries";
import type { PickedPhoto } from "../lib/photo";

// API client for the failed-delivery / exception workflow. The server owns all
// timestamps and content digests — the client only supplies operation UUIDs +
// the raw values; it can never forge a server receipt time.

export interface ExceptionActionRow {
  id: string;
  type: string;
  resolution: string | null;
  actor_id: string;
  actor_role: string;
  note: string | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  client_at: string | null;
  created_at: string;
}
export interface ExceptionEvidenceRow {
  id: string;
  kind: string;
  action_id: string | null;
  url: string;
  created_at: string;
  captured_client_at: string | null;
}
/** Full aggregate (admin / assigned driver). */
export interface ExceptionFull {
  id: string;
  trip_id: string;
  trip_stop_id: string | null;
  category: string;
  reason: string;
  reported_by: string;
  reported_at: string;
  current_state: string;
  resolution: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  is_open: boolean;
  version: number;
  created_at: string;
  actions: ExceptionActionRow[];
  evidence: ExceptionEvidenceRow[];
}
/** Redacted view (requestor). */
export interface ExceptionRedacted {
  id: string;
  trip_id: string;
  category: string;
  status: "open" | "resolved";
  reported_at: string;
  resolved_at: string | null;
}
export interface ExceptionListRow {
  id: string;
  trip_id: string;
  ticket_number: string;
  driver_name: string | null;
  truck_plate: string | null;
  category: string;
  current_state: string;
  reason: string;
  reported_at: string;
  stop: { sequence: number; arrived_at: string | null; company_name: string } | null;
}

export interface ReportExceptionInput {
  category: string;
  reason: string;
  tripStopId?: string | null;
  photo: PickedPhoto;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  clientAt: string;
  capturedClientAt: string;
  clientOccurrenceId: string;
  clientActionId: string;
  clientEvidenceId: string;
}

async function reportForm(input: ReportExceptionInput): Promise<FormData> {
  const form = new FormData();
  form.append("category", input.category);
  form.append("reason", input.reason);
  if (input.tripStopId) form.append("trip_stop_id", input.tripStopId);
  form.append("client_occurrence_id", input.clientOccurrenceId);
  form.append("client_action_id", input.clientActionId);
  form.append("client_evidence_id", input.clientEvidenceId);
  if (input.lat != null) form.append("lat", String(input.lat));
  if (input.lng != null) form.append("lng", String(input.lng));
  if (input.accuracyM != null) form.append("accuracy_m", String(input.accuracyM));
  form.append("client_at", input.clientAt);
  form.append("captured_client_at", input.capturedClientAt);
  await appendPhoto(form, "photo", input.photo);
  return form;
}

export async function reportExceptionForTrip(tripId: string, input: ReportExceptionInput): Promise<ExceptionFull> {
  const form = await reportForm(input);
  const res = await api.post<{ exception: ExceptionFull }>(`/trips/${tripId}/exception`, form, { headers: UPLOAD_HEADERS, timeout: 60_000 });
  return res.data.exception;
}

export async function addExceptionEvidence(
  tripId: string,
  exId: string,
  opts: { photo: PickedPhoto; clientEvidenceId: string; capturedClientAt: string }
): Promise<ExceptionFull> {
  const form = new FormData();
  form.append("client_evidence_id", opts.clientEvidenceId);
  form.append("captured_client_at", opts.capturedClientAt);
  await appendPhoto(form, "photo", opts.photo);
  const res = await api.post<{ exception: ExceptionFull }>(`/trips/${tripId}/exception/${exId}/evidence`, form, { headers: UPLOAD_HEADERS, timeout: 60_000 });
  return res.data.exception;
}

export async function getTripException(tripId: string): Promise<ExceptionFull | ExceptionRedacted | null> {
  const res = await api.get<{ exception: ExceptionFull | ExceptionRedacted | null }>(`/trips/${tripId}/exception`);
  return res.data.exception;
}

export async function listOpenExceptions(): Promise<ExceptionListRow[]> {
  const res = await api.get<{ exceptions: ExceptionListRow[] }>(`/trips/exceptions/open`);
  return res.data.exceptions;
}

// ── Admin transitions ─────────────────────────────────────────────────────
export interface AdminActionInput {
  clientActionId: string;
  note?: string;
  expectedVersion?: number;
}
function actionBody(input: AdminActionInput): Record<string, unknown> {
  return {
    client_action_id: input.clientActionId,
    ...(input.note != null ? { note: input.note } : {}),
    ...(input.expectedVersion != null ? { expected_version: input.expectedVersion } : {}),
  };
}
const adminAction = (verb: string) => async (tripId: string, exId: string, input: AdminActionInput): Promise<ExceptionFull> => {
  const res = await api.post<{ exception: ExceptionFull }>(`/trips/${tripId}/exception/${exId}/${verb}`, actionBody(input));
  return res.data.exception;
};
export const verifyException = adminAction("verify");
export const requestMoreEvidence = adminAction("request-more-evidence");
export const rejectException = adminAction("reject");
export const resumeException = adminAction("resume");
export async function resolveException(tripId: string, exId: string, input: AdminActionInput & { resolution: string }): Promise<ExceptionFull> {
  const res = await api.post<{ exception: ExceptionFull }>(`/trips/${tripId}/exception/${exId}/resolve`, { ...actionBody(input), resolution: input.resolution });
  return res.data.exception;
}
