/**
 * Thin typed wrapper over the UWC Fleet REST API (the same backend the mobile
 * and admin apps call). Specs use these to seed and reset trip state directly,
 * so each browser test is independent of the others.
 *
 * Uses Node's global fetch (Node 18+).
 */
import { API_BASE, DRIVER_TRUCK_PLATE, type Account } from "./accounts";

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; name: string; role: string };
}

export type TripStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "assigned"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface Stop {
  id: string;
  sequence: number;
  status: string;
  consignee_id: string;
  consignee?: { id: string; company_name: string; zone_code: string };
}

export interface Trip {
  id: string;
  ticket_number: string;
  status: TripStatus;
  requestor_id: string;
  driver_id: string | null;
  truck_plate: string | null;
  incentive_earned: string | number | null;
  pickup_datetime: string;
  auto_dispatch_failed: boolean; // Phase 2: needs-attention flag (self-clearing)
  stops: Stop[];
  [key: string]: unknown;
}

export interface DashboardKpis {
  pending_trips: number;
  auto_dispatch_failed: number; // Phase 2: pending bookings the engine couldn't place
  awaiting_manual: number; // Phase 2: pending bookings awaiting manual dispatch
  [key: string]: unknown;
}

export interface Consignee {
  id: string;
  company_name: string;
  zone_code: string;
  area?: string | null;
}

async function req<T = any>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const code = data?.error?.code ?? res.status;
    const msg = data?.error?.message ?? text;
    throw new Error(`API ${method} ${path} → ${res.status} ${code}: ${msg}`);
  }
  return data as T;
}

// ── Auth / profile ──────────────────────────────────────────────────────
export function login(account: Account): Promise<LoginResult> {
  return req(null, "POST", "/auth/login", { phone: account.phone, password: account.password });
}

export function getMe(token: string): Promise<{ assigned_truck: { plate: string } | null }> {
  return req(token, "GET", "/users/me");
}

// ── Reference data ──────────────────────────────────────────────────────
export function getRouteTypes(token: string): Promise<{ id: string; name: string }[]> {
  return req(token, "GET", "/route-types");
}

export function searchConsignees(
  token: string,
  opts: { search?: string; zone?: string } = {}
): Promise<Consignee[]> {
  const qs = new URLSearchParams();
  if (opts.search) qs.set("search", opts.search);
  if (opts.zone) qs.set("zone", opts.zone);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return req(token, "GET", `/consignees${suffix}`);
}

// ── Trips ───────────────────────────────────────────────────────────────
export function getTrips(token: string): Promise<Trip[]> {
  return req(token, "GET", "/trips");
}

export function getTrip(token: string, id: string): Promise<Trip> {
  return req(token, "GET", `/trips/${id}`);
}

export interface CreateTripInput {
  route_type_id: string;
  pickup_datetime: string;
  stops: { consignee_id: string; sequence?: number }[];
  cargo_details: { pallet_type: string; quantity: number }[];
}

export function createTrip(token: string, input: CreateTripInput): Promise<Trip> {
  return req(token, "POST", "/trips", input);
}

export function approveTrip(
  adminToken: string,
  id: string,
  body: { driver_id: string; truck_plate: string; force?: boolean }
): Promise<Trip> {
  return req(adminToken, "PATCH", `/trips/${id}/approve`, body);
}

export function cancelTrip(token: string, id: string): Promise<Trip> {
  return req(token, "PATCH", `/trips/${id}/cancel`);
}

export function autoDispatch(adminToken: string, tripId: string): Promise<{ trip: Trip }> {
  return req(adminToken, "POST", "/dispatch/auto", { trip_id: tripId });
}

// ── Driver status transitions ───────────────────────────────────────────
export function driverStatus(
  driverToken: string,
  id: string,
  action: "start" | "arrived" | "delivered",
  stopId?: string
): Promise<Trip> {
  return req(driverToken, "PATCH", `/trips/${id}/status`, {
    action,
    ...(stopId ? { stop_id: stopId } : {}),
  });
}

export function markStopDocs(
  driverToken: string,
  id: string,
  stopId: string,
  body: { do_uploaded?: boolean; k2_form_ack?: boolean }
): Promise<Trip> {
  return req(driverToken, "PATCH", `/trips/${id}/stops/${stopId}/docs`, body);
}

/**
 * Upload a real POD photo for a stop (multipart, field "photo" — the same
 * request the driver app sends). The server stores the Cloudinary URL and
 * flips do_uploaded, satisfying the documentation gate legitimately —
 * do_uploaded can no longer be self-attested without a photo
 * (400 POD_PHOTO_REQUIRED).
 */
export async function uploadPod(
  driverToken: string,
  id: string,
  stopId: string,
  file: { name: string; mimeType: string; buffer: Buffer }
): Promise<Trip> {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.name);
  const res = await fetch(`${API_BASE}/trips/${id}/stops/${stopId}/pod`, {
    method: "POST",
    headers: { Authorization: `Bearer ${driverToken}` }, // no Content-Type: fetch sets the multipart boundary
    body: form,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const code = data?.error?.code ?? res.status;
    const msg = data?.error?.message ?? text;
    throw new Error(`API POST /trips/${id}/stops/${stopId}/pod → ${res.status} ${code}: ${msg}`);
  }
  return data as Trip;
}

/**
 * Upload the Borang K2 customs document for a stop (multipart, field "photo" —
 * the same request the driver app sends from the ActiveTrip K2 button). Sets
 * k2_photo server-side, which the K2-zone delivery gate keys on (R1 Q6: an
 * uploaded document, not a tick).
 */
export async function uploadK2(
  driverToken: string,
  id: string,
  stopId: string,
  file: { name: string; mimeType: string; buffer: Buffer }
): Promise<Trip> {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.name);
  const res = await fetch(`${API_BASE}/trips/${id}/stops/${stopId}/k2`, {
    method: "POST",
    headers: { Authorization: `Bearer ${driverToken}` },
    body: form,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const code = data?.error?.code ?? res.status;
    const msg = data?.error?.message ?? text;
    throw new Error(`API POST /trips/${id}/stops/${stopId}/k2 → ${res.status} ${code}: ${msg}`);
  }
  return data as Trip;
}

// ── Exceptions (Phase 1, feature-flagged: FEATURE_EXCEPTIONS=true) ──────
export interface ExceptionPayload {
  id: string;
  category: string;
  current_state: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Driver reports an exception (multipart: photo + category + reason + the three
 * client idempotency UUIDs the offline outbox normally generates). Mirrors the
 * ReportExceptionSheet request — used to seed past the in-browser camera
 * capture, which headless Chromium cannot drive (same limitation as POD).
 */
export async function reportException(
  driverToken: string,
  tripId: string,
  opts: {
    category: string;
    reason: string;
    tripStopId?: string;
    file: { name: string; mimeType: string; buffer: Buffer };
  }
): Promise<ExceptionPayload> {
  const form = new FormData();
  form.append("category", opts.category);
  form.append("reason", opts.reason);
  form.append("client_occurrence_id", crypto.randomUUID());
  form.append("client_action_id", crypto.randomUUID());
  form.append("client_evidence_id", crypto.randomUUID());
  if (opts.tripStopId) form.append("trip_stop_id", opts.tripStopId);
  form.append(
    "photo",
    new Blob([new Uint8Array(opts.file.buffer)], { type: opts.file.mimeType }),
    opts.file.name
  );
  const res = await fetch(`${API_BASE}/trips/${tripId}/exception`, {
    method: "POST",
    headers: { Authorization: `Bearer ${driverToken}` },
    body: form,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const code = data?.error?.code ?? res.status;
    const msg = data?.error?.message ?? text;
    throw new Error(`API POST /trips/${tripId}/exception → ${res.status} ${code}: ${msg}`);
  }
  return (data as { exception: ExceptionPayload }).exception;
}

/** Admin: all open exceptions (the Exceptions lane's data source). */
export function getOpenExceptions(
  adminToken: string
): Promise<{ exceptions: { id: string; trip_id: string; current_state: string }[] }> {
  return req(adminToken, "GET", "/trips/exceptions/open");
}

/**
 * Admin: RESUME an exception — the one Phase-1 action that closes it from any
 * open state (reported/more_evidence/verified) while the trip stays
 * in_progress. (`resolve` is Phase-1-gated to `retry` and rejects other
 * resolutions, so resume is the cleanup path.)
 */
export function resumeException(
  adminToken: string,
  tripId: string,
  exId: string
): Promise<unknown> {
  return req(adminToken, "POST", `/trips/${tripId}/exception/${exId}/resume`, {
    client_action_id: crypto.randomUUID(),
    note: "e2e reset — clearing the open exception",
  });
}

// ── Truck rates (admin) ─────────────────────────────────────────────────
export interface TruckRate {
  plate: string;
  entitled_claim_weekday: number;
  entitled_claim_offpeak: number;
  daily_deduction_points: number;
  max_pallets: number;
  [key: string]: unknown;
}

export function getTrucks(adminToken: string): Promise<TruckRate[]> {
  return req(adminToken, "GET", "/trucks");
}

/** The current weekday claim rate for one plate (via GET /trucks). */
export async function getTruckWeekdayRate(adminToken: string, plate: string): Promise<number> {
  const trucks = await getTrucks(adminToken);
  const t = trucks.find((x) => x.plate === plate);
  if (!t) throw new Error(`Truck ${plate} not found.`);
  return Number(t.entitled_claim_weekday);
}

/**
 * The STAGED (next-MYT-day cutoff) weekday rate for one plate, or null when no
 * edit is pending. Rate edits no longer change the live value same-day — they
 * stage here and take effect tomorrow (client rule, 3 Jul 2026).
 */
export async function getTruckPendingWeekdayRate(
  adminToken: string,
  plate: string
): Promise<number | null> {
  const trucks = await getTrucks(adminToken);
  const t = trucks.find((x) => x.plate === plate);
  if (!t) throw new Error(`Truck ${plate} not found.`);
  const pending = t.pending_rates as { entitled_claim_weekday: number | null } | null;
  return pending?.entitled_claim_weekday ?? null;
}

export function patchTruckRates(
  adminToken: string,
  plate: string,
  body: { entitled_claim_weekday?: number; entitled_claim_offpeak?: number; daily_deduction_points?: number }
): Promise<unknown> {
  return req(adminToken, "PATCH", `/trucks/${encodeURIComponent(plate)}/rates`, body);
}

export function resetTruckRatesToSpec(adminToken: string): Promise<{
  updated: { plate: string; changes: { field: string; from: number; to: number }[] }[];
  already_at_spec: string[];
  skipped: string[];
}> {
  return req(adminToken, "POST", "/trucks/reset-rates", {});
}

// ── Driver leave (admin) — date-based dispatch availability ─────────────
export function getDriverBoard(
  adminToken: string
): Promise<{ id: string; name: string; status: string }[]> {
  return req(adminToken, "GET", "/reports/drivers");
}

export function addLeave(
  adminToken: string,
  body: { driver_id: string; start_date: string; end_date?: string; note?: string }
): Promise<{ id: string }> {
  return req(adminToken, "POST", "/leaves", body);
}

export function deleteLeave(adminToken: string, id: string): Promise<{ deleted: boolean }> {
  return req(adminToken, "DELETE", `/leaves/${id}`);
}

// ── Dashboard KPIs (admin) ──────────────────────────────────────────────
export function getDashboard(adminToken: string): Promise<DashboardKpis> {
  return req(adminToken, "GET", "/reports/dashboard");
}

// ── Dispatch mode (admin) ───────────────────────────────────────────────
export function getDispatchMode(token: string): Promise<{ dispatch_mode: "manual" | "auto" }> {
  return req(token, "GET", "/settings/dispatch-mode");
}

export function setDispatchMode(
  adminToken: string,
  mode: "manual" | "auto"
): Promise<{ dispatch_mode: string }> {
  return req(adminToken, "PATCH", "/settings/dispatch-mode", { dispatch_mode: mode });
}

// ── Identity helper: the test driver's id + assigned truck plate ─────────
export async function driverIdentity(account: Account): Promise<{
  token: string;
  id: string;
  plate: string;
}> {
  const { accessToken, user } = await login(account);
  const me = await getMe(accessToken);
  return { token: accessToken, id: user.id, plate: me.assigned_truck?.plate ?? DRIVER_TRUCK_PLATE };
}
