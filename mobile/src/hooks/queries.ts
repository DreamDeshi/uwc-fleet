import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";
import {
  Consignee,
  Department,
  IncentiveSummary,
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

export function useConsignees(search: string) {
  return useQuery({
    queryKey: ["consignees", search],
    queryFn: async () =>
      (await api.get<Consignee[]>("/consignees", { params: search ? { search } : {} })).data,
    staleTime: 1000 * 30,
  });
}

// ── Trips ──────────────────────────────────────────────────────────────
export function useTrips() {
  return useQuery({
    queryKey: ["trips"],
    queryFn: async () => (await api.get<Trip[]>("/trips")).data,
  });
}

export function useTrip(tripId: string) {
  return useQuery({
    queryKey: ["trip", tripId],
    queryFn: async () => (await api.get<Trip>(`/trips/${tripId}`)).data,
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
    onSuccess: (trip) => {
      qc.invalidateQueries({ queryKey: ["trips"] });
      qc.invalidateQueries({ queryKey: ["trip", trip.id] });
      qc.invalidateQueries({ queryKey: ["incentives", "mine"] });
    },
  });
}

export function useCancelTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tripId: string) =>
      (await api.patch<Trip>(`/trips/${tripId}/cancel`)).data,
    onSuccess: (trip) => {
      qc.invalidateQueries({ queryKey: ["trips"] });
      qc.invalidateQueries({ queryKey: ["trip", trip.id] });
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
    onSuccess: (trip) => {
      qc.invalidateQueries({ queryKey: ["trip", trip.id] });
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
  });
}

// ── Uploads (multipart/form-data) ────────────────────────────────────────
import { PickedPhoto } from "../lib/photo";
import { DocumentType } from "../types";

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
      form.append("photo", { uri: photo.uri, name: photo.name, type: photo.type } as any);
      return (
        await api.post<Trip>(`/trips/${tripId}/stops/${stopId}/pod`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 60_000,
        })
      ).data;
    },
    onSuccess: (trip) => {
      qc.invalidateQueries({ queryKey: ["trip", trip.id] });
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
      form.append("file", { uri: photo.uri, name: photo.name, type: photo.type } as any);
      form.append("type", type);
      return (
        await api.post<Trip>(`/trips/${tripId}/documents`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 60_000,
        })
      ).data;
    },
    onSuccess: (trip) => {
      qc.invalidateQueries({ queryKey: ["trip", trip.id] });
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
}

export function useCreateConsignee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateConsigneeInput) =>
      (await api.post<Consignee>("/consignees", input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consignees"] }),
  });
}
