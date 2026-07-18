import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../services/api";
import type {
  AdminUser,
  AttentionReport,
  AuditFilterOptions,
  AuditPage,
  Consignee,
  ConsolidationSavings,
  DashboardKpis,
  Department,
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
  Role,
  Trip,
  TripPage,
  Truck,
  TruckExpiryAlert,
  TruckFuelLogs,
  TruckFuelSummary,
  UserStatus,
} from "../types";

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

// Every mounted useTrips re-downloads its window (full include) on the 20s
// poll, so each page requests only what it renders (audit #6): the
// dashboard's recent handful, MobileLite's phone screen, Reports' pie
// window. Filters always search the FULL history server-side — the limit
// caps the result, not the search. The trip BOARD no longer uses this
// legacy window: it pages with useTripBoard below.
const DEFAULT_LIMIT = 300;

export function useTrips(
  filters: TripFilters = {},
  opts: { poll?: boolean; limit?: number } = {}
) {
  const { poll = true, limit = DEFAULT_LIMIT } = opts;
  const params: Record<string, string> = { limit: String(limit) };
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
    // the dispatch panel reads trip state from this list. Pages that only
    // aggregate (ReportsPage's pie) opt out of the poll entirely.
    refetchInterval: poll ? 20_000 : false,
    ...(poll ? {} : { staleTime: 5 * 60_000 }),
  });
}

// ── True pagination for the trip board (the cb6bd55 follow-up) ────────
// The board polls only its LOADED pages. By default that is just the first
// page — the live head under (created_at desc, id desc), where every new
// booking enters and where anything operationally live sits — so the 20s
// poll re-downloads a bounded window, never the growing history. "Load
// older" appends further keyset pages on demand; react-query refetches
// loaded pages SEQUENTIALLY with recomputed cursors on every poll and
// invalidation, so the loaded set stays gap- and duplicate-free even as
// bookings arrive mid-walk, and status changes on old loaded trips are
// picked up too. Changing filters (new key) or navigating away resets the
// working set back to one page.
const BOARD_PAGE_SIZE = 150;

export function useTripBoard(filters: TripFilters = {}) {
  const params: Record<string, string> = { page_size: String(BOARD_PAGE_SIZE) };
  for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
  return useInfiniteQuery({
    // Shares the ["trips"] prefix, so every mutation that invalidates
    // ["trips"] refetches the board exactly like the legacy list.
    queryKey: ["trips", "board", params],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<TripPage>("/trips", {
          params: pageParam ? { ...params, cursor: pageParam } : params,
        })
      ).data,
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // Same rationale as useTrips: keep the previous board while a new filter
    // combination loads / poll every 20s so other actors' changes appear.
    placeholderData: keepPreviousData,
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

// Audit trail (admin, read-only). Keyset-paged newest-first; optional table /
// action filters. Shares the tanstack infinite-query shape used by the board.
export function useAuditLog(filters: { table?: string; action?: string } = {}) {
  const base: Record<string, string> = { limit: "50" };
  if (filters.table) base.table = filters.table;
  if (filters.action) base.action = filters.action;
  return useInfiniteQuery({
    queryKey: ["audit", base],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<AuditPage>("/audit", {
          params: pageParam ? { ...base, cursor: pageParam } : base,
        })
      ).data,
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

// Consolidation ("empty-mile") savings KPI — deliveries that shared a trip, plus
// an estimated fuel/CO2 avoided. Cumulative over completed trips.
export function useConsolidationSavings() {
  return useQuery({
    queryKey: ["reports", "consolidation"],
    queryFn: async () => (await api.get<ConsolidationSavings>("/reports/consolidation")).data,
    staleTime: 5 * 60_000,
  });
}

export function useAuditFilters() {
  return useQuery({
    queryKey: ["audit", "filters"],
    queryFn: async () => (await api.get<AuditFilterOptions>("/audit/filters")).data,
    staleTime: 5 * 60_000,
  });
}

// Consignee directory management (admin). include_inactive lets the admin
// find deactivated rows to reactivate; the API caps results at 10, so the
// search box is the primary navigation.
export interface ConsigneeImportResult {
  created: number;
  skipped: { line: number; reason: string }[];
}
export function useImportConsignees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (csv: string) => (await api.post<ConsigneeImportResult>("/consignees/import", { csv })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consignees"] }),
  });
}

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
      contact_person?: string;
      phone?: string;
      address_1?: string;
      address_2?: string;
      area?: string;
      state?: string;
      postal_code?: string;
      vendor_code?: string;
      // Past a 409 warning (rename SIMILAR_EXISTS / deactivate CONSIGNEE_IN_USE).
      force?: boolean;
    }) => {
      const { id, ...patch } = args;
      return (await api.patch<Consignee>(`/consignees/${id}`, patch)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consignees"] }),
  });
}

/** Admin add — same POST the requestor self-add uses (dedupe + force apply). */
export function useCreateConsignee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      company_name: string;
      zone_code: string;
      address_1?: string;
      address_2?: string;
      postal_code?: string;
      area?: string;
      state?: string;
      contact_person?: string;
      phone?: string;
      force?: boolean;
    }) => (await api.post<Consignee>("/consignees", args)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consignees"] }),
  });
}

/**
 * The fleet, with each truck's load and loading detail for ONE MYT day.
 *
 * `date` ("YYYY-MM-DD" MYT) is item 7b — "let admin to select to show the cargo
 * capacity based on different date". Omitted = today, the screen's long-standing
 * behaviour, so every other caller is unaffected.
 *
 * The query key keeps its "trucks" prefix so the ~10 existing
 * invalidateQueries({ queryKey: ["trucks"] }) calls still match every date's
 * cache entry; keepPreviousData stops the fleet blanking out while a newly
 * picked date loads.
 */
export function useTrucks(date?: string) {
  const params = date ? { date } : {};
  return useQuery({
    queryKey: ["trucks", params],
    queryFn: async () => (await api.get<Truck[]>("/trucks", { params })).data,
    placeholderData: keepPreviousData,
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

// ── All Users (Part B) ─────────────────────────────────────────────────────
export interface UserFilters {
  role?: Role;
  status?: UserStatus;
}

export function useUsers(filters: UserFilters = {}) {
  return useQuery({
    queryKey: ["users", "all", filters.role ?? "any", filters.status ?? "any"],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters.role) params.role = filters.role;
      if (filters.status) params.status = filters.status;
      return (await api.get<AdminUser[]>("/users", { params })).data;
    },
  });
}

// Broad ["users"] invalidation so BOTH the All-Users list and the pending queue
// refresh after any user mutation (partial key match covers every sub-key).
export function useChangeUserRole() {
  const invalidate = useInvalidate([["users"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: { id: string; role: Role }) =>
      (await api.patch<AdminUser>(`/users/${v.id}/role`, { role: v.role })).data,
    onSuccess: invalidate,
  });
}

export function useSetUserStatus() {
  const invalidate = useInvalidate([["users"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: { id: string; status: UserStatus }) =>
      (await api.patch(`/users/${v.id}/approve`, { status: v.status })).data,
    onSuccess: invalidate,
  });
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: async (v: { user_id: string; new_password: string }) =>
      (await api.post("/auth/forgot-password", v)).data,
  });
}

export interface AdminUpdateUserInput {
  id: string;
  name?: string;
  phone?: string;
  department_id?: string;
  employee_number?: string;
}

export function useAdminUpdateUser() {
  const invalidate = useInvalidate([["users"]]);
  return useMutation({
    mutationFn: async ({ id, ...body }: AdminUpdateUserInput) =>
      (await api.patch<AdminUser>(`/users/${id}`, body)).data,
    onSuccess: invalidate,
  });
}

// ── Fleet management (add/retire drivers & trucks) ──────────────────────────
// Departments feed the Add-Driver form's picker (same list registration uses).
export function useDepartments() {
  return useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
    staleTime: 1000 * 60 * 60,
  });
}

export interface CreateDriverInput {
  phone: string;
  password: string;
  name: string;
  employee_number: string;
  department_id: string;
  assigned_truck_plate?: string;
}

// A fleet add/retire touches the driver board, the users list, the trucks
// board (a bound/freed truck changes its "driver" cell) and the dashboard.
export function useCreateDriver() {
  const invalidate = useInvalidate([["drivers"], ["users"], ["trucks"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (body: CreateDriverInput) => (await api.post("/users", body)).data,
    onSuccess: invalidate,
  });
}

// plate=string binds/reassigns; plate=null frees the truck (the departed-driver
// path). Server enforces the 1:1 binding + not-retired + no-active-trip guards.
export function useAssignDriverTruck() {
  const invalidate = useInvalidate([["drivers"], ["users"], ["trucks"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: { id: string; plate: string | null }) =>
      (await api.patch(`/users/${v.id}/truck`, { plate: v.plate })).data,
    onSuccess: invalidate,
  });
}

// Retire (disable) / reactivate a driver — /approve, but invalidating the driver
// board + trucks too (unlike the All-Users useSetUserStatus).
export function useSetDriverStatus() {
  const invalidate = useInvalidate([["drivers"], ["users"], ["trucks"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: { id: string; status: "active" | "disabled" }) =>
      (await api.patch(`/users/${v.id}/approve`, { status: v.status })).data,
    onSuccess: invalidate,
  });
}

export interface CreateTruckInput {
  plate: string;
  type: string;
  max_pallets: number;
  entitled_claim_weekday: number;
  entitled_claim_offpeak: number;
  daily_deduction_points: number;
  priority_zones?: string[];
  operating_hours_start?: string;
  operating_hours_end?: string;
}

export function useCreateTruck() {
  const invalidate = useInvalidate([["trucks"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (body: CreateTruckInput) => (await api.post<Truck>("/trucks", body)).data,
    onSuccess: invalidate,
  });
}

// Edit NON-money attributes only (type / capacity / zones / hours). Rates and
// documents keep their own endpoints — this never touches the money path.
export function useUpdateTruck() {
  const invalidate = useInvalidate([["trucks"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: {
      plate: string;
      type?: string;
      max_pallets?: number;
      priority_zones?: string[];
      operating_hours_start?: string;
      operating_hours_end?: string;
    }) => {
      const { plate, ...body } = v;
      return (await api.patch<Truck>(`/trucks/${encodeURIComponent(plate)}`, body)).data;
    },
    onSuccess: invalidate,
  });
}

// Retire frees the truck's driver (server-side) and drops it from dispatch +
// alerts, so refresh drivers/alerts alongside the fleet list.
export function useRetireTruck() {
  const invalidate = useInvalidate([["trucks"], ["trucks", "alerts"], ["drivers"], ["dashboard"]]);
  return useMutation({
    mutationFn: async (v: { plate: string; retired: boolean }) =>
      (await api.patch(`/trucks/${encodeURIComponent(v.plate)}/retire`, { retired: v.retired })).data,
    onSuccess: invalidate,
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

// Admin de-orphan lever: abort an IN-PROGRESS trip whose driver can't finish
// (departed/incapacitated) → cancelled, which frees the truck and lets the
// driver be disabled. No pay is finalized. Refresh drivers/trucks too (the
// freed truck + the now-tripless driver both change board state).
export function useAbortTrip() {
  const invalidate = useInvalidate([["trips"], ["dashboard"], ["drivers"], ["trucks"]]);
  return useMutation({
    mutationFn: async (v: { id: string; reason?: string }) =>
      (await api.patch<Trip>(`/trips/${v.id}/abort`, v.reason ? { reason: v.reason } : {})).data,
    onSuccess: invalidate,
  });
}

// ── POD incentive-approval gate (Mr. Teh, 16 Jul 2026) ────────────────────
// A delivered trip sits in `pending_approval` with its incentive PROPOSED but
// not paid. The admin reviews the POD + amount and approves (optionally editing
// the final amount, which requires a reason). Polled like the board so a newly
// delivered trip surfaces here — and on the nav badge — without an F5.
export function usePendingApprovals(opts: { poll?: boolean } = {}) {
  const { poll = true } = opts;
  return useQuery({
    queryKey: ["trips", "pending-approvals"],
    queryFn: async () =>
      (await api.get<Trip[]>("/trips", { params: { status: "pending_approval", limit: "300" } })).data,
    refetchInterval: poll ? 20_000 : false,
  });
}

// Approve a delivered trip's incentive → the trip completes and the payable
// `incentive_final` is set. Omit final_amount to confirm the proposal as-is;
// pass it (with a reason) to edit. Refresh reports/drivers too: approving is
// the moment the money becomes payable, so every earnings figure changes.
export function useApproveIncentive() {
  const invalidate = useInvalidate([
    ["trips"],
    ["dashboard"],
    ["drivers"],
    ["reports"],
  ]);
  return useMutation({
    mutationFn: async (v: { id: string; final_amount?: number; reason?: string }) =>
      (await api.patch<Trip>(`/trips/${v.id}/approve-incentive`, {
        ...(v.final_amount !== undefined ? { final_amount: v.final_amount } : {}),
        ...(v.reason ? { reason: v.reason } : {}),
      })).data,
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
