import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type {
  AdminUser,
  DashboardKpis,
  DestinationRate,
  DriverPerf,
  DriverPerformance,
  FuelLog,
  LivePosition,
  MonthlyRow,
  Trip,
  Truck,
  TruckExpiryAlert,
  TruckFuelLogs,
  TruckFuelSummary,
} from "@/types";

// ── Queries ──────────────────────────────────────────────────────────
export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await api.get<DashboardKpis>("/reports/dashboard")).data,
    refetchInterval: 30_000,
  });
}

export function useTrips() {
  return useQuery({
    queryKey: ["trips"],
    queryFn: async () => (await api.get<Trip[]>("/trips")).data,
  });
}

export function useTrucks() {
  return useQuery({
    queryKey: ["trucks"],
    queryFn: async () => (await api.get<Truck[]>("/trucks")).data,
  });
}

// FR-MT1 — trucks with an expired or soon-to-expire document. Polled so the nav
// badge and alerts panel stay current without a manual refresh.
export function useTruckAlerts() {
  return useQuery({
    queryKey: ["trucks", "alerts"],
    queryFn: async () => (await api.get<TruckExpiryAlert[]>("/trucks/alerts")).data,
    refetchInterval: 60_000,
  });
}

// Live truck GPS positions — polled every 15s so the fleet map stays current.
export function useFleetLive() {
  return useQuery({
    queryKey: ["fleet", "live"],
    queryFn: async () => (await api.get<LivePosition[]>("/fleet/live")).data,
    refetchInterval: 15_000,
  });
}

export function useDrivers() {
  return useQuery({
    queryKey: ["drivers"],
    queryFn: async () => (await api.get<DriverPerf[]>("/reports/drivers")).data,
  });
}

// FR-FM7 — per-driver performance scores for the Driver Management page.
export function useDriverPerformance() {
  return useQuery({
    queryKey: ["drivers", "performance"],
    queryFn: async () =>
      (await api.get<DriverPerformance[]>("/users/drivers/performance")).data,
  });
}

// FR-CT5 — this month's fuel spend per truck (Fuel tab overview table).
export function useFuelSummary() {
  return useQuery({
    queryKey: ["trucks", "fuel", "summary"],
    queryFn: async () => (await api.get<TruckFuelSummary[]>("/trucks/fuel/summary")).data,
  });
}

// All fuel logs for one truck — only fetched when a row is expanded.
export function useTruckFuel(plate: string | null) {
  return useQuery({
    queryKey: ["trucks", "fuel", plate],
    queryFn: async () =>
      (await api.get<TruckFuelLogs>(`/trucks/${encodeURIComponent(plate!)}/fuel`)).data,
    enabled: plate !== null,
  });
}

export interface LogFuelInput {
  plate: string;
  litres: number;
  cost_rm: number;
  odometer_km: number;
  logged_at?: string;
}

export function useLogFuel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ plate, ...body }: LogFuelInput) =>
      (await api.post<FuelLog>(`/trucks/${encodeURIComponent(plate)}/fuel`, body)).data,
    onSuccess: (_log, vars) => {
      qc.invalidateQueries({ queryKey: ["trucks", "fuel", "summary"] });
      qc.invalidateQueries({ queryKey: ["trucks", "fuel", vars.plate] });
    },
  });
}

export function useDestinationRates() {
  return useQuery({
    queryKey: ["rates", "destinations"],
    queryFn: async () => (await api.get<DestinationRate[]>("/rates/destinations")).data,
  });
}

export function useMonthly() {
  return useQuery({
    queryKey: ["reports", "monthly"],
    queryFn: async () => (await api.get<MonthlyRow[]>("/reports/monthly")).data,
  });
}

export function useDispatchMode() {
  return useQuery({
    queryKey: ["settings", "dispatch-mode"],
    queryFn: async () =>
      (await api.get<{ dispatch_mode: "manual" | "auto" }>("/settings/dispatch-mode")).data
        .dispatch_mode,
  });
}

export function useSetDispatchMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mode: "manual" | "auto") =>
      (await api.patch<{ dispatch_mode: "manual" | "auto" }>("/settings/dispatch-mode", {
        dispatch_mode: mode,
      })).data.dispatch_mode,
    // Optimistically flip the toggle, roll back on error.
    onMutate: async (mode) => {
      await qc.cancelQueries({ queryKey: ["settings", "dispatch-mode"] });
      const prev = qc.getQueryData<"manual" | "auto">(["settings", "dispatch-mode"]);
      qc.setQueryData(["settings", "dispatch-mode"], mode);
      return { prev };
    },
    onError: (_err, _mode, ctx) => {
      if (ctx?.prev) qc.setQueryData(["settings", "dispatch-mode"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["settings", "dispatch-mode"] }),
  });
}

export function usePendingUsers() {
  return useQuery({
    queryKey: ["users", "pending_approval"],
    queryFn: async () =>
      (await api.get<AdminUser[]>("/users", { params: { status: "pending_approval" } })).data,
  });
}

// ── Mutations ────────────────────────────────────────────────────────
function useInvalidate(keys: string[][]) {
  const qc = useQueryClient();
  return () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
}

export function useApproveTrip() {
  const invalidate = useInvalidate([["trips"], ["dashboard"], ["drivers"], ["trucks"]]);
  return useMutation({
    mutationFn: async (v: { id: string; driver_id: string; truck_plate: string }) =>
      (await api.patch<Trip>(`/trips/${v.id}/approve`, {
        driver_id: v.driver_id,
        truck_plate: v.truck_plate,
      })).data,
    onSuccess: invalidate,
  });
}

export function useRejectTrip() {
  const invalidate = useInvalidate([["trips"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: { id: string; reason?: string }) =>
      (await api.patch<Trip>(`/trips/${v.id}/reject`, { reason: v.reason })).data,
    onSuccess: invalidate,
  });
}

export function useAssignExternal() {
  const invalidate = useInvalidate([["trips"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: {
      id: string;
      company_name: string;
      booking_date: string;
      rate: number;
      cargo_size: string;
    }) =>
      (await api.patch<Trip>(`/trips/${v.id}/assign-external`, {
        company_name: v.company_name,
        booking_date: v.booking_date,
        rate: v.rate,
        cargo_size: v.cargo_size,
      })).data,
    onSuccess: invalidate,
  });
}

export function useCancelTrip() {
  const invalidate = useInvalidate([["trips"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (id: string) => (await api.patch<Trip>(`/trips/${id}/cancel`, {})).data,
    onSuccess: invalidate,
  });
}

export function useUpdateTruckRates() {
  const invalidate = useInvalidate([["trucks"]]);
  return useMutation({
    mutationFn: async (v: {
      plate: string;
      entitled_claim_weekday?: number;
      entitled_claim_offpeak?: number;
      daily_deduction_points?: number;
    }) => {
      const { plate, ...body } = v;
      return (await api.patch(`/trucks/${encodeURIComponent(plate)}/rates`, body)).data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateDestinationRate() {
  const invalidate = useInvalidate([["rates", "destinations"]]);
  return useMutation({
    mutationFn: async (v: { id: string; points: number }) =>
      (await api.patch<DestinationRate>(`/rates/destinations/${v.id}`, { points: v.points })).data,
    onSuccess: invalidate,
  });
}

export function useApproveUser() {
  const invalidate = useInvalidate([["users", "pending_approval"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: { id: string; status: "active" | "disabled" }) =>
      (await api.patch(`/users/${v.id}/approve`, { status: v.status })).data,
    onSuccess: invalidate,
  });
}
