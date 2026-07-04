import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type {
  AdminUser,
  AttentionReport,
  Consignee,
  DashboardKpis,
  DestinationRate,
  DriverLeaveEntry,
  DriverPerf,
  DriverPerformance,
  FuelLog,
  LivePosition,
  MonthlyRow,
  PayrollResponse,
  PublicHoliday,
  RateAuditEntry,
  RateResetResult,
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

// Optional admin search/filters for GET /trips. Omitted/empty fields are not
// sent, so `useTrips()` with no args behaves exactly as before.
export interface TripFilters {
  q?: string;
  status?: string;
  driver_id?: string;
  zone?: string;
  date_from?: string;
  date_to?: string;
}

export function useTrips(filters: TripFilters = {}) {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
  return useQuery({
    // Params are part of the key so each filter combination caches separately;
    // invalidating ["trips"] still matches all of them by prefix.
    queryKey: ["trips", params],
    queryFn: async () => (await api.get<Trip[]>("/trips", { params })).data,
    // Keep showing the prior results while a new filter combination loads, so the
    // board and the filter bar don't blank out / lose focus on each keystroke.
    placeholderData: keepPreviousData,
    // Polled like the dashboard/fleet/alerts queries: new bookings, the sweep's
    // auto-assignments, and other admins' changes must appear without an F5 —
    // the dispatch panel reads trip state from this list.
    refetchInterval: 20_000,
  });
}

// Single-trip detail. Only this endpoint returns the `timeline` array, so the
// detail panel fetches it on selection rather than relying on the list payload.
export function useTrip(id: string | null) {
  return useQuery({
    queryKey: ["trips", "detail", id],
    queryFn: async () => (await api.get<Trip>(`/trips/${id}`)).data,
    enabled: !!id,
  });
}

// Consignee directory management (admin). include_inactive lets the admin
// find deactivated rows to reactivate; the API caps results at 10, so the
// search box is the primary navigation.
export function useConsignees(search: string, includeInactive: boolean) {
  return useQuery({
    queryKey: ["consignees", search, includeInactive],
    queryFn: async () =>
      (
        await api.get<Consignee[]>("/consignees", {
          params: {
            ...(search ? { search } : {}),
            ...(includeInactive ? { include_inactive: "1" } : {}),
          },
        })
      ).data,
    placeholderData: keepPreviousData,
  });
}

export function useUpdateConsignee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      company_name?: string;
      zone_code?: string;
      is_active?: boolean;
      // Past a 409 warning (rename SIMILAR_EXISTS / deactivate CONSIGNEE_IN_USE).
      force?: boolean;
    }) => {
      const { id, ...patch } = args;
      return (await api.patch<Consignee>(`/consignees/${id}`, patch)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consignees"] }),
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

// Latest "who changed what" per truck / destination, for the last-updated note.
export function useRateAudit() {
  return useQuery({
    queryKey: ["rates", "audit"],
    queryFn: async () => (await api.get<RateAuditEntry[]>("/rates/audit")).data,
  });
}

export function useMonthly() {
  return useQuery({
    queryKey: ["reports", "monthly"],
    queryFn: async () => (await api.get<MonthlyRow[]>("/reports/monthly")).data,
  });
}

// The clerk's month-end payroll sheet — any month selectable (YYYY-MM, MYT).
export function usePayroll(month: string) {
  return useQuery({
    queryKey: ["reports", "payroll", month],
    queryFn: async () =>
      (await api.get<PayrollResponse>("/reports/payroll", { params: { month } })).data,
    placeholderData: keepPreviousData,
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
    mutationFn: async (v: { id: string; driver_id: string; truck_plate: string; force?: boolean }) =>
      (await api.patch<Trip>(`/trips/${v.id}/approve`, {
        driver_id: v.driver_id,
        truck_plate: v.truck_plate,
        ...(v.force ? { force: true } : {}),
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

// Admin ops lever (client Q3): pull the driver off an ASSIGNED trip — the
// trip returns to pending and re-enters the dispatch flow.
export function useUnassignTrip() {
  const invalidate = useInvalidate([["trips"], ["dashboard"], ["drivers"], ["trucks"]]);
  return useMutation({
    mutationFn: async (v: { id: string; reason?: string }) =>
      (await api.patch<Trip>(`/trips/${v.id}/unassign`, { reason: v.reason })).data,
    onSuccess: invalidate,
  });
}

// Admin ops lever (client Q3): move an ASSIGNED trip to another driver+truck.
// Runs the full assignment guard ladder server-side; rate snapshot re-taken.
export function useReassignTrip() {
  const invalidate = useInvalidate([["trips"], ["dashboard"], ["drivers"], ["trucks"]]);
  return useMutation({
    mutationFn: async (v: {
      id: string;
      driver_id: string;
      truck_plate: string;
      force?: boolean;
      reason?: string;
    }) =>
      (await api.patch<Trip>(`/trips/${v.id}/reassign`, {
        driver_id: v.driver_id,
        truck_plate: v.truck_plate,
        ...(v.force ? { force: true } : {}),
        ...(v.reason ? { reason: v.reason } : {}),
      })).data,
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
  const invalidate = useInvalidate([["trucks"], ["rates", "audit"]]);
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

export function useResetTruckRates() {
  // A reset touches every truck's rate row, so refresh the trucks list and the
  // rate-audit trail (the endpoint writes a rate_reset_to_spec audit row).
  const invalidate = useInvalidate([["trucks"], ["rates", "audit"], ["dashboard"]]);
  return useMutation({
    mutationFn: async () => (await api.post<RateResetResult>("/trucks/reset-rates", {})).data,
    onSuccess: invalidate,
  });
}

export function useUpdateTruckDocuments() {
  // Renewal path for the roadworthiness gate: recording a new expiry date
  // un-blocks the truck for dispatch, so refresh the fleet + alert views.
  const invalidate = useInvalidate([["trucks"], ["trucks", "alerts"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: {
      plate: string;
      insurance_expiry?: string | null;
      permit_expiry?: string | null;
      road_tax_expiry?: string | null;
    }) => {
      const { plate, ...body } = v;
      return (await api.patch<Truck>(`/trucks/${encodeURIComponent(plate)}/documents`, body)).data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateDestinationRate() {
  const invalidate = useInvalidate([["rates", "destinations"], ["rates", "audit"]]);
  return useMutation({
    mutationFn: async (v: { id: string; points: number }) =>
      (await api.patch<DestinationRate>(`/rates/destinations/${v.id}`, { points: v.points })).data,
    onSuccess: invalidate,
  });
}

// Stuck/stale trips needing a human — polled so the dashboard card stays live.
export function useAttention() {
  return useQuery({
    queryKey: ["reports", "attention"],
    queryFn: async () => (await api.get<AttentionReport>("/reports/attention")).data,
    refetchInterval: 60_000,
  });
}

// ── Driver leave (admin-managed calendar; drives dispatch availability) ──
export function useLeaves() {
  return useQuery({
    queryKey: ["leaves"],
    queryFn: async () => (await api.get<DriverLeaveEntry[]>("/leaves")).data,
  });
}

export function useAddLeave() {
  // The driver board embeds leave ranges, so refresh it alongside the list.
  const invalidate = useInvalidate([["leaves"], ["drivers"]]);
  return useMutation({
    mutationFn: async (v: { driver_id: string; start_date: string; end_date?: string; note?: string }) =>
      (await api.post<DriverLeaveEntry>("/leaves", v)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteLeave() {
  const invalidate = useInvalidate([["leaves"], ["drivers"]]);
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/leaves/${id}`)).data,
    onSuccess: invalidate,
  });
}

// ── Public holidays (admin-managed calendar; drives the off-peak rate) ──
export function useHolidays() {
  return useQuery({
    queryKey: ["holidays"],
    queryFn: async () => (await api.get<PublicHoliday[]>("/holidays")).data,
  });
}

export function useAddHoliday() {
  const invalidate = useInvalidate([["holidays"]]);
  return useMutation({
    mutationFn: async (v: { date: string; name: string }) =>
      (await api.post<PublicHoliday>("/holidays", v)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteHoliday() {
  const invalidate = useInvalidate([["holidays"]]);
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/holidays/${id}`)).data,
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
