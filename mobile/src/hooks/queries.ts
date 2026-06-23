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
