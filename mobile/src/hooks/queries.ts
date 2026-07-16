import { useMemo } from "react";
import { Platform } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";
import {
  Consignee,
  Department,
  IncentiveSummary,
  Me,
  RouteType,
  Trip,
} from "../types";

// ── Reference data ────────────────────────────────────────────────────
export function useDepartments() {
  return useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
    staleTime: 1000 * 60 * 60, // rarely changes
  });
}

export function useRouteTypes() {
  return useQuery({
    queryKey: ["route-types"],
    queryFn: async () => (await api.get<RouteType[]>("/route-types")).data,
    staleTime: 1000 * 60 * 60,
  });
}

// Minimum chars before we hit the API — a single letter matches almost the
// whole directory, so searching only kicks in at 2+ characters.
export const CONSIGNEE_SEARCH_MIN = 2;

export function useConsignees(search: string) {
  const q = search.trim();
  const enabled = q.length >= CONSIGNEE_SEARCH_MIN;
  return useQuery({
    queryKey: ["consignees", q],
    // Always send the typed value as ?search=<q> (never empty/null) so the API
    // actually filters; the `enabled` gate keeps us from firing below the min.
    queryFn: async () =>
      (await api.get<Consignee[]>("/consignees", { params: { search: q } })).data,
    enabled,
    staleTime: 1000 * 30,
  });
}

// ── Public holidays ────────────────────────────────────────────────────
// The admin-managed calendar (GET /holidays) as a Set of "YYYY-MM-DD" MYT
// keys — what estimateIncentive's off-peak check consumes. Replaces the old
// hardcoded client list. Changes rarely, so it can be cached for the session;
// while loading, the empty set just means "no holidays" (estimate refines
// once the calendar arrives — the server value stays authoritative anyway).
export function useHolidaySet(): ReadonlySet<string> {
  const { data } = useQuery({
    queryKey: ["holidays"],
    queryFn: async () =>
      (await api.get<{ id: string; date: string; name: string }[]>("/holidays")).data,
    staleTime: 1000 * 60 * 60,
  });
  return useMemo(() => new Set((data ?? []).map((h) => h.date)), [data]);
}

// ── Trips ──────────────────────────────────────────────────────────────
// Real-time refresh: push isn't configured on the web deployment (documented
// limitation), so the driver/requestor screens POLL for new assignments,
// approvals and rejections the same way the admin board does — a change shows
// up within ~25s without pulling to refresh. react-query pauses the timer while
// the tab is hidden; native builds still also receive real push.
const TRIP_POLL_MS = 25_000;

export function useTrips() {
  return useQuery({
    queryKey: ["trips"],
    queryFn: async () => (await api.get<Trip[]>("/trips")).data,
    refetchInterval: TRIP_POLL_MS,
  });
}

export function useTrip(tripId: string) {
  return useQuery({
    queryKey: ["trip", tripId],
    queryFn: async () => (await api.get<Trip>(`/trips/${tripId}`)).data,
    // Guarded so callers that only sometimes have a trip (the booking form in
    // edit mode) can pass "" without firing a bogus GET /trips/.
    enabled: Boolean(tripId),
    // Keep the open booking/trip live as its status advances (assigned →
    // in transit → delivered) without push — see the note on useTrips.
    refetchInterval: TRIP_POLL_MS,
  });
}

// The real road path for a trip (Google Directions, computed server-side).
// The route only depends on the trip's fixed stops, so it can be cached a while.
export interface TripRoute {
  polyline: { latitude: number; longitude: number }[];
  distance_m: number | null;
  duration_s: number | null;
  source: "google" | "straight";
}

export function useTripRoute(tripId: string, enabled = true) {
  return useQuery({
    queryKey: ["trip-route", tripId],
    queryFn: async () => (await api.get<TripRoute>(`/trips/${tripId}/route`)).data,
    enabled,
    staleTime: 1000 * 60 * 30,
  });
}

// Latest GPS fix of the truck on this trip (null until the driver pings). Polled
// while the trip is being tracked so the requestor's mini-map stays current.
export interface TripLatestLocation {
  latitude: number;
  longitude: number;
  recorded_at: string;
  source: string; // "phone" | "vendor"
  stale: boolean;
}

export function useTripLatestLocation(tripId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["trip-location", tripId],
    queryFn: async () =>
      (await api.get<TripLatestLocation | null>(`/trips/${tripId}/location`)).data,
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useIncentives() {
  return useQuery({
    queryKey: ["incentives", "mine"],
    queryFn: async () => (await api.get<IncentiveSummary>("/incentives/mine")).data,
  });
}

// ── My performance (FR-FM7 personal view) — the logged-in driver only ───────
// The API returns ONLY this driver's own metrics plus a tier and an anonymous
// percentile band — no leaderboard, no peer names/scores. `has_data` is false
// (tier/band null) until the driver has at least one completed trip.
export type PerformanceTier = "Gold" | "Silver" | "Bronze";

export interface MyPerformance {
  total_score: number;
  tier: PerformanceTier | null;
  percentile_band: string | null;
  on_time_rate: number;
  completion_rate: number;
  total_completed: number;
  rm_earned_this_month: number;
  has_data: boolean;
}

export function useMyPerformance() {
  return useQuery({
    queryKey: ["performance", "mine"],
    queryFn: async () => (await api.get<MyPerformance>("/users/me/performance")).data,
  });
}

// ── Requestor analytics (FR-RS1-5) — scoped to the logged-in requestor ──────
export interface RequestorAnalytics {
  monthly_activity: { month: string; count: number }[]; // last 6 MYT months
  status_breakdown: {
    completed: number;
    pending: number;
    assigned: number;
    in_progress: number;
    cancelled: number;
  };
  top_destinations: { name: string; count: number }[];
  cargo_history: { total_pallets: number; by_size: { size: string; count: number }[] };
  avg_approval_time_hours: number | null;
}

export function useMyAnalytics() {
  return useQuery({
    queryKey: ["analytics", "mine"],
    queryFn: async () => (await api.get<RequestorAnalytics>("/analytics/mine")).data,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────
export interface CreateTripInput {
  route_type_id: string;
  pickup_datetime: string; // ISO
  stops: { consignee_id: string }[];
  cargo_details: {
    pallet_type: string;
    quantity: number;
    cartons?: number;
    custom_size?: string;
    remark?: string;
  }[];
}

export function useCreateTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTripInput) => (await api.post<Trip>("/trips", input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

// Requestor fixes their own still-PENDING booking — same payload shape as
// create (is_external and everything assignment/money-related is locked
// server-side). A 400/409 means the booking just left pending under them.
export function useUpdateTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tripId, input }: { tripId: string; input: CreateTripInput }) =>
      (await api.patch<Trip>(`/trips/${tripId}`, input)).data,
    // Settled, not success — see useUpdateTripStatus (lost-response reconcile).
    onSettled: (_trip, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["trips"] });
      qc.invalidateQueries({ queryKey: ["trip", vars.tripId] });
    },
  });
}

export interface StatusInput {
  tripId: string;
  action: "start" | "arrived" | "delivered";
  stop_id?: string;
}

export function useUpdateTripStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tripId, action, stop_id }: StatusInput) =>
      (await api.patch<Trip>(`/trips/${tripId}/status`, { action, stop_id })).data,
    // Invalidate on SETTLED, not just success: on bad signal a status write
    // can commit server-side while the response is lost — the driver's retry
    // then 409s, and without an error-path refetch the screen keeps showing
    // a stale button that "keeps failing" on a trip that's actually done.
    // The tripId comes from the mutation variables (there's no response on
    // the error path).
    onSettled: (_trip, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["trips"] });
      qc.invalidateQueries({ queryKey: ["trip", vars.tripId] });
      qc.invalidateQueries({ queryKey: ["incentives", "mine"] });
    },
  });
}

export function useCancelTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tripId: string) =>
      (await api.patch<Trip>(`/trips/${tripId}/cancel`)).data,
    // Settled, not success — see useUpdateTripStatus (lost-response reconcile).
    // The tripId comes from the variables: there's no response on the error path.
    onSettled: (_trip, _err, tripId) => {
      qc.invalidateQueries({ queryKey: ["trips"] });
      qc.invalidateQueries({ queryKey: ["trip", tripId] });
    },
  });
}

export interface StopDocsInput {
  tripId: string;
  stopId: string;
  do_uploaded?: boolean;
  k2_form_ack?: boolean;
}

export function useUpdateStopDocs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tripId, stopId, do_uploaded, k2_form_ack }: StopDocsInput) =>
      (await api.patch<Trip>(`/trips/${tripId}/stops/${stopId}/docs`, { do_uploaded, k2_form_ack }))
        .data,
    // Settled, not success — see useUpdateTripStatus (lost-response reconcile).
    onSettled: (_trip, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["trip", vars.tripId] });
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
  });
}

// ── Uploads (multipart/form-data) ────────────────────────────────────────
import { PickedPhoto } from "../lib/photo";
import { DocumentType } from "../types";

// React Native and the browser build a multipart body differently:
//   • Native: FormData accepts a { uri, name, type } object and RN streams the
//     file off disk; the request must carry an explicit multipart Content-Type.
//   • Web: that object would serialize to the string "[object Object]" (no file
//     bytes), so we fetch the uri into a real Blob/File and append that. The
//     boundary is handled by UPLOAD_HEADERS below (see the note there).
export async function appendPhoto(form: FormData, field: string, photo: PickedPhoto) {
  if (Platform.OS === "web") {
    const blob = await (await fetch(photo.uri)).blob();
    form.append(field, new File([blob], photo.name, { type: photo.type }));
  } else {
    form.append(field, { uri: photo.uri, name: photo.name, type: photo.type } as any);
  }
}

// Set multipart on BOTH platforms. The axios instance defaults Content-Type to
// application/json (services/api.ts); if we leave it on an upload, axios 1.x sees
// FormData + a JSON content-type and serializes the form to JSON, dropping the
// file bytes — which is why web uploads silently failed. Overriding to
// multipart/form-data prevents that: on native RN fills in the boundary, and on
// web axios's XHR adapter strips this header for a FormData body so the browser
// regenerates it with the correct boundary.
export const UPLOAD_HEADERS = { "Content-Type": "multipart/form-data" };

// POD photo for a stop. The API stores the Cloudinary URL on the stop and flips
// do_uploaded, which satisfies the "Delivered" gate.
export function useUploadPod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tripId,
      stopId,
      photo,
    }: {
      tripId: string;
      stopId: string;
      photo: PickedPhoto;
    }) => {
      const form = new FormData();
      await appendPhoto(form, "photo", photo);
      return (
        await api.post<Trip>(`/trips/${tripId}/stops/${stopId}/pod`, form, {
          headers: UPLOAD_HEADERS,
          timeout: 60_000,
        })
      ).data;
    },
    // Settled, not success — a POD upload can also commit while its response
    // is lost; refetching shows the stored photo instead of an empty slot.
    onSettled: (_trip, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["trip", vars.tripId] });
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
  });
}

// Requestor/admin uploads a DO or invoice against a booking.
export function useUploadTripDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tripId,
      photo,
      type,
    }: {
      tripId: string;
      photo: PickedPhoto;
      type: DocumentType;
    }) => {
      const form = new FormData();
      await appendPhoto(form, "file", photo);
      form.append("type", type);
      return (
        await api.post<Trip>(`/trips/${tripId}/documents`, form, {
          headers: UPLOAD_HEADERS,
          timeout: 60_000,
        })
      ).data;
    },
    // Settled, not success — THE duplicate-document guard (audit 2026-07-05):
    // each POST creates a new TripDocument row, so a commit-with-lost-response
    // that only refetched on success left the requestor staring at an "empty"
    // slot, retrying, and filing the DO twice. Refetching on the error path
    // shows the document that actually landed, so there's nothing to retry.
    // The tripId comes from the variables: there's no response on errors.
    onSettled: (_trip, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["trip", vars.tripId] });
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
  });
}

export interface CreateConsigneeInput {
  company_name: string;
  zone_code: string;
  contact_person?: string;
  phone?: string;
  area?: string;
  state?: string;
  postal_code?: string;
  // Re-submit with force after a SIMILAR_EXISTS warning to create anyway.
  force?: boolean;
}

export function useCreateConsignee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateConsigneeInput) =>
      (await api.post<Consignee>("/consignees", input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consignees"] }),
  });
}

// ── Fuel logging (FR-CT5) ────────────────────────────────────────────────
// Drivers log fill-ups against their own assigned truck from the Profile screen.
export interface LogFuelInput {
  plate: string;
  litres: number;
  cost_rm: number;
  odometer_km: number;
}

export function useLogFuel() {
  return useMutation({
    mutationFn: async ({ plate, ...body }: LogFuelInput) =>
      (await api.post(`/trucks/${encodeURIComponent(plate)}/fuel`, body)).data,
  });
}

// ── Self-service account (Part A) ──────────────────────────────────────────
// The logged-in user edits their OWN profile / password. Phone (login ID) and
// employee_number are admin-managed; role/status are never self-set.
export interface UpdateProfileInput {
  name?: string;
  department_id?: string;
}

export function useUpdateProfile() {
  return useMutation({
    mutationFn: async (input: UpdateProfileInput) =>
      (await api.patch<Me>("/users/me", input)).data,
  });
}

export interface ChangePasswordInput {
  current_password: string;
  new_password: string;
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (input: ChangePasswordInput) =>
      (await api.patch<{ ok: true }>("/users/me/password", input)).data,
  });
}
