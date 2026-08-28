// API response shapes (mirrors the Express + Prisma payloads at /api/v1).

export type Role = "admin" | "driver" | "requestor";
export type UserStatus = "pending_approval" | "active" | "disabled";
export type TripStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "assigned"
  | "in_progress"
  | "pending_approval"
  | "completed"
  | "cancelled";
export type StopStatus = "pending" | "arrived" | "delivered";

export interface AuthUser {
  id: string;
  phone: string;
  name: string;
  role: Role;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface AdminUser {
  id: string;
  phone: string;
  name: string;
  employee_number: string | null;
  role: Role;
  status: UserStatus;
  department_id: string | null;
  created_at: string;
  /**
   * SC3 login lockout. ISO timestamp while the account is locked out of
   * signing in, null otherwise. ⚠ A PAST timestamp means the lock has already
   * expired — the server treats it as unlocked, so the UI must compare against
   * now rather than testing for presence.
   */
  locked_until: string | null;
}

// Self-service password reset request (owner-approved design, 20 Aug 2026).
export interface PasswordResetRequest {
  id: string;
  status: "pending" | "approved" | "dismissed" | "expired";
  requested_at: string;
  resolved_at: string | null;
  resolved_by: { id: string; name: string } | null;
  user: {
    id: string;
    name: string;
    phone: string;
    employee_number: string | null;
    assigned_truck_plate: string | null;
    is_locked: boolean;
    last_login_at: string | null;
  };
}

export interface Department {
  id: string;
  name: string;
}

export interface Consignee {
  id: string;
  company_name: string;
  // Full legal name (company_name is suffix-stripped for display) — the
  // consignee editor must initialise from and save this one.
  company_name_full?: string;
  vendor_code: string | null;
  area: string | null;
  state: string | null;
  address_1?: string | null;
  address_2?: string | null;
  postal_code?: string | null;
  zone_code: string;
  is_active?: boolean;
  /**
   * FALSE when this address falls back to the zone centre rather than a real
   * building. Server-derived from coordinate presence (routes/consignees).
   *
   * Optional, and readers must test `=== false`: UNDEFINED means an older
   * payload that never carried the field, which is NOT the same claim as
   * "this one is area-level" and must not draw the chip.
   */
  has_position?: boolean;
}

// ── Payroll (GET /reports/payroll) ────────────────────────────────────
export interface PayrollTripRow {
  id: string;
  ticket_number: string;
  pickup_datetime: string;
  delivered_at: string | null; // first delivery confirm — the pay-deciding instant
  incentive_earned: number; // stored per-trip marginal
}

export interface PayrollDriverRow {
  driver_id: string;
  name: string;
  employee_number: string | null;
  trip_count: number;
  total: number; // month total RM, cents-rounded server-side
  trips: PayrollTripRow[];
}

export interface PayrollResponse {
  month: string; // YYYY-MM (MYT)
  drivers: PayrollDriverRow[];
}

export interface CargoDetail {
  id: string;
  pallet_type: string;
  quantity: number;
  cartons: number | null;
  custom_size: string | null;
  remark: string | null;
}

export interface TripStop {
  id: string;
  sequence: number;
  consignee_id: string;
  consignee: Consignee;
  status: StopStatus;
  arrived_at: string | null;
  delivered_at: string | null;
  do_uploaded: boolean;
  k2_form_ack: boolean;
  // Cloudinary URL of the driver's proof-of-delivery photo. Client-confirmed
  // (Q2, 3 Jul 2026): pay is automatic once the mandatory photo is uploaded;
  // admin only does random SPOT-CHECKS — this link is that view.
  pod_photo: string | null;
  // Server receipt time of the POD upload (IM6) — the timestamp a contested
  // approval is argued over. NULL = unknown (POD predates the column).
  pod_uploaded_at?: string | null;
  // DEVICE-reported capture time (IM6 pair). Untrusted evidence, never a
  // pay input; NULL when the device did not say. Label it as device-reported.
  pod_captured_client_at?: string | null;
  // The Borang K2 customs document (IM9). Signed, short-lived Cloudinary URL —
  // the server mints it per request in lib/podPhotos.ts (signStop) and drops
  // the public_id, so this is the ONLY usable handle on the asset.
  //
  // ⚠ MAY BE A PDF, AND THE URL CANNOT TELL YOU. signedK2Url passes no
  // `format` (K2 has no format column), so unlike a TripDocument's file_url
  // this one carries NO extension — the requestor paperwork row's
  // image-vs-PDF regex would be false for every K2. Never render it as an
  // <Image>; hand it to the system viewer. See lib/k2Evidence.
  k2_photo?: string | null;
  // Finalize-time scoring evidence (per-drop points, repeat flag, zone
  // snapshot). Null = trip completed before the breakdown feature.
  points_awarded?: number | null;
  was_repeat?: boolean | null;
  zone_code?: string | null;
  // Stop-attached exception headers (tripInclude) — lets the admin app tell a
  // SETTLED stop (reached, verified + resumed, PAID under R3 Q11(a)) from an
  // outstanding one. `status` alone cannot: a settled stop stays
  // "pending"/"arrived". See lib/stopSettled. Optional: absent → not settled.
  exceptions?: {
    current_state: string;
    resolution: string | null;
    actions?: { type: string }[];
  }[];
}

export interface RouteType {
  id: string;
  name: string;
}

export type DocumentType = "do_photo" | "k2_form" | "other";

export interface TripDocument {
  id: string;
  trip_id: string;
  type: DocumentType;
  file_url: string;
  uploaded_at: string;
}

export interface TripParty {
  id: string;
  name: string;
  phone: string;
}

export type TripEvent =
  | "booked"
  | "assigned"
  | "started"
  | "stop_arrived"
  | "stop_delivered"
  | "completed"
  | "rejected"
  | "cancelled"
  | "assigned_external"
  | "rerouted";

export type TimelineStepState = "done" | "current" | "upcoming";

// One milestone in the adaptive status timeline (built server-side in
// api/src/lib/tripTimeline.ts and returned on GET /trips/:id).
export interface TimelineStep {
  event: TripEvent;
  state: TimelineStepState;
  timestamp: string | null;
  note?: string | null;
  stopId?: string;
  stopSequence?: number;
  stopLabel?: string;
}

export interface Trip {
  id: string;
  ticket_number: string;
  requestor_id: string;
  requestor: TripParty;
  driver_id: string | null;
  driver: TripParty | null;
  truck_plate: string | null;
  truck: Truck | null;
  route_type_id: string;
  route_type: RouteType;
  status: TripStatus;
  pickup_datetime: string;
  incentive_earned: string | null; // the engine PROPOSAL (frozen at delivery)
  // POD-approval gate (16 Jul 2026). incentive_final is the admin-APPROVED
  // payable amount (null until approved / on pre-gate trips → paid at proposal).
  incentive_final?: string | null;
  incentive_override_reason?: string | null; // set only when the admin edited the amount
  incentive_approved_at?: string | null;
  incentive_approved_by?: string | null;
  // Finalize-time pay evidence (engine outputs persisted with the incentive).
  // Null on pre-feature trips; rate_used/off_peak also null on the rare
  // midnight-straddling trip (per-stop rows remain exact).
  rate_used?: string | null; // Decimal serialises as string
  off_peak?: boolean | null;
  deduction_applied?: number | null;
  is_external: boolean;
  rejection_reason: string | null;
  // Phase 2: true when auto-dispatch couldn't place this booking. Self-clearing.
  // "Needs attention" UI shows for (status === "pending" && auto_dispatch_failed).
  auto_dispatch_failed: boolean;
  // WHY the engine couldn't place it — cleared together with the flag.
  auto_dispatch_note: string | null;
  // True when an admin manually unassigned this trip (feedback item 15): it sits
  // in pending but is PINNED to manual handling — the auto-dispatch sweep skips
  // it, so it won't be silently re-assigned. Cleared on the next manual assign.
  auto_dispatch_paused?: boolean;
  created_at: string;
  stops: TripStop[];
  cargo_details: CargoDetail[];
  documents?: TripDocument[];
  // Present only on the GET /trips/:id detail response, not on list items.
  timeline?: TimelineStep[];
}

// One keyset page of GET /trips?page_size=…&cursor=… (paged mode). The
// cursor is opaque; total counts every trip matching the current filters,
// so the board can say "N of total" and size its Load-older button.
export interface TripPage {
  items: Trip[];
  next_cursor: string | null;
  total: number;
}

export interface TruckAlert {
  doc: "insurance" | "permit" | "road_tax";
  expiry: string;
  daysLeft: number;
}

// FR-MT1 — document-expiry alerts (GET /trucks/alerts).
export type ExpiryStatus = "expired" | "expiring_soon" | "ok";

export interface DocExpiry {
  expiry_date: string | null;
  days_until_expiry: number | null;
  status: ExpiryStatus;
}

export interface TruckExpiryAlert {
  plate: string;
  type: string;
  insurance: DocExpiry;
  permit: DocExpiry;
  road_tax: DocExpiry;
}

export interface Truck {
  plate: string;
  type: string;
  max_pallets: number;
  entitled_claim_weekday: number;
  entitled_claim_offpeak: number;
  daily_deduction_points: number;
  // A staged rate edit waiting for its next-MYT-day cutoff (client rule):
  // today's assignments still pay the live values above until effective_date.
  pending_rates: {
    entitled_claim_weekday: number | null;
    entitled_claim_offpeak: number | null;
    daily_deduction_points: number | null;
    effective_date: string; // MYT "YYYY-MM-DD"
  } | null;
  priority_zones: string[];
  operating_hours_start: string;
  operating_hours_end: string;
  insurance_expiry: string | null;
  permit_expiry: string | null;
  road_tax_expiry: string | null;
  is_available: boolean;
  retired_at: string | null;
  status: "active" | "idle" | "maintenance" | "retired";
  driver: TripParty | null;
  current_load: number;
  current_route: string | null;
  /**
   * What MAKES UP current_load — one entry per trip aboard on the day being
   * viewed, always summing to it (item 7b). The load bar says how full a truck
   * is; this says with what, for whom, and from which ticket.
   */
  current_loading: TruckLoading[];
  trips_today: number;
  alerts: TruckAlert[];
}

export interface TruckLoading {
  trip_id: string;
  ticket_number: string;
  status: TripStatus;
  /** The assignment's pickup instant — "the date of assigment cargo". */
  pickup_datetime: string;
  /** The LAST stop's consignee company name; null if the trip has no stops. */
  destination: string | null;
  /** That stop's area, falling back to its zone code — the old route label. */
  destination_area: string | null;
  stop_count: number;
  /** This trip's 4×4-equivalents; the entries sum to the truck's current_load. */
  pallets: number;
  cargo: TruckLoadingCargo[];
}

export interface TruckLoadingCargo {
  /** "4×4"… for pallets, or "carton"/"custom" — there is no separate type column. */
  pallet_type: string;
  quantity: number;
  estimated_pallets: number | null;
  remark: string | null;
}

// Phase 5: a truck's latest real GPS fix (from GET /fleet/live).
export interface LivePosition {
  plate: string;
  trip_id: string;
  ticket_number: string;
  driver: { id: string; name: string } | null;
  latitude: number;
  longitude: number;
  recorded_at: string;
  source: string; // "phone" | "vendor" — fleet map prefers a fresh vendor fix
  stale: boolean; // no ping for >3 min — show as "signal lost"
}

export type DriverStatus = "on_trip" | "available" | "off_duty";

export interface DriverPerf {
  id: string;
  name: string;
  phone: string;
  account_status: UserStatus;
  status: DriverStatus;
  // Leave is DATE-scoped (it doesn't change `status`): current + upcoming
  // ranges, inclusive "YYYY-MM-DD" MYT. The dispatch panel checks them against
  // the trip's pickup date; the server enforces on approve/auto anyway.
  on_leave_today: boolean;
  leaves: { start_date: string; end_date: string; note: string | null }[];
  assigned_truck: { plate: string; max_pallets: number } | null;
  current_load: number; // pallets already on this driver's truck (active trips)
  scheduled_trips: number; // assigned-but-not-started trips queued for this driver
  trips_total: number;
  trips_this_month: number;
  trips_today: number;
  incentive_this_month: number;
  current_route: string | null;
}

// Stuck/stale trips needing a human (GET /reports/attention) — read-only.
export interface AttentionTrip {
  id: string;
  ticket_number: string;
  status: string;
  pickup_datetime: string;
  truck_plate: string | null;
  driver: { name: string; phone: string } | null;
  hours_since_pickup: number;
}
// Delivery confirmed far from the consignee's stored coordinate — a
// REVIEW-ONLY flag (never blocks, never touches pay). Optional fields keep
// the app tolerant of an API that predates the check.
export interface EarlyTapTrip extends AttentionTrip {
  stop_id: string;
  consignee_name: string;
  delivered_at: string;
  distance_m: number;
}
export interface AttentionReport {
  thresholds: {
    staleInProgressHours: number;
    overdueAssignedHours: number;
    earlyTapRadiusM?: number;
    earlyTapWindowMin?: number;
  };
  stale_in_progress: AttentionTrip[];
  overdue_assigned: AttentionTrip[];
  completed_null_incentive: AttentionTrip[];
  // Assigned trips whose driver has since been put on leave covering the
  // pickup date (client Q3) — reassign or unassign these. Self-clearing.
  assigned_driver_on_leave: AttentionTrip[];
  early_tap_delivery?: EarlyTapTrip[];
}

// Geocode coverage counts (GET /consignees/coverage) — read-only signal for
// when a manual geocode/self-heal run is worth doing.
export interface ConsigneeCoverage {
  total_active: number;
  missing_coords: number;
  /** The subset of missing_coords a geocode run would actually fill — the rest
   *  have already been asked and declined (coarse match, or a demoted
   *  duplicate). Only this number justifies suggesting a run. */
  never_geocoded: number;
  /** The subset where the LOOKUP BROKE rather than answered — no API key, a
   *  transport failure, a quota wall. Disjoint from never_geocoded. These need
   *  someone to look at the system, not at the address, and a geocode run only
   *  helps once the cause is fixed. Before this existed a broken lookup wrote
   *  nothing, so it counted as never_geocoded and the screen advised a run. */
  failed_lookup: number;
  partial_coords: number;
}

// One driver-leave entry (GET /leaves) — admin-managed dispatch availability.
export interface DriverLeaveEntry {
  id: string;
  driver_id: string;
  start_date: string; // inclusive "YYYY-MM-DD" MYT
  end_date: string; // inclusive
  note: string | null;
  driver: { name: string; assigned_truck_plate: string | null };
}

// FR-FM7 — driver performance score (GET /users/drivers/performance).
export interface DriverPerformance {
  id: string;
  name: string;
  employee_number: string | null;
  truck_plate: string | null;
  total_completed: number; // completed trips all-time; 0 → render a "No data" badge
  total_cancelled: number; // cancelled trips all-time (workload/reliability context)
  completed_this_month: number; // completed trips this MYT month (workload lens)
  distance_km_this_month: number; // estimated round-trip km this month (productivity)
  rm_earned_this_month: number; // incentive earned this month (== points_this_month)
  on_time_rate: number; // percent of completed trips on time
  completion_rate: number; // percent of assigned trips completed (vs cancelled)
  points_this_month: number; // month incentive total feeding the points component
  on_time_component: number; // 0–40
  completion_component: number; // 0–30
  points_component: number; // 0–30
  total_score: number; // 0–100, 1 dp
}

export interface DashboardKpis {
  total_trucks: number;
  active_trucks: number;
  trips_today: number;
  trips_in_progress: number;
  completed_today: number;
  on_time_rate: number | null;
  pending_approvals: number;
  pending_trips: number;
  // Phase 2: split the conflated "unassigned" count. failed ⊆ pending_trips.
  auto_dispatch_failed: number; // pending bookings the engine couldn't place
  awaiting_manual: number; // pending bookings simply awaiting manual dispatch
  alerts: number;
  // Exception reports nobody has closed. Optional so a client running against an
  // older API renders the chip without a count instead of "undefined".
  // ⚠ This is the exception workflow's ONLY dependable admin signal: both
  // exception pushes need `expo_push_token`, which never issues on web, and a
  // production read on 12 Aug 2026 found ZERO users of any role holding one.
  open_exceptions?: number;
}

// FR-CT5 — fuel cost tracking.
export interface FuelLog {
  id: string;
  truck_plate: string;
  liters: number;
  cost: number;
  odometer: number | null;
  logged_at: string;
  driver: { name: string } | null;
}

export interface GlobalSearchResults {
  trips: { id: string; ticket_number: string; status: string }[];
  users: { id: string; name: string; role: Role; phone: string }[];
  consignees: { id: string; company_name: string; zone_code: string; area: string | null }[];
}

export interface ConsolidationSavings {
  trips: number;
  drops: number;
  tripsSaved: number;
  estKmSaved: number;
  estLitresSaved: number;
  estCo2eKgSaved: number;
  // Smallest-fit dispatch savings, current MYT month. Optional so the app
  // tolerates an API that predates the field.
  rightSizing?: RightSizingSavings;
}

export interface RightSizingSavings {
  trips: number;
  tripsRightSized: number;
  estLitresSaved: number;
  estCo2eKgSaved: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  table_name: string;
  record_id: string;
  timestamp: string;
  user: { id: string; name: string; role: Role } | null;
}
export interface AuditPage {
  rows: AuditEntry[];
  nextCursor: string | null;
}
export interface AuditFilterOptions {
  actions: string[];
  tables: string[];
}

export interface FuelSummary {
  log_count: number;
  total_litres: number;
  total_cost_rm: number;
  avg_cost_per_litre: number | null;
  total_km_covered: number;
  cost_per_km: number | null;
  // Efficiency + carbon (fuel dashboard) — display only.
  litres_per_100km: number | null;
  co2e_kg: number;
  co2e_kg_per_km: number | null;
}

// One row of GET /trucks/fuel/summary (this month, per truck).
export interface TruckFuelSummary extends FuelSummary {
  plate: string;
  type: string;
}

// GET /trucks/:plate/fuel — all logs for a truck plus its all-time summary.
export interface TruckFuelLogs {
  logs: FuelLog[];
  summary: FuelSummary;
}

export interface DestinationRate {
  id: string;
  zone_code: string | null;
  location_name: string;
  points: number;
  // A staged points edit waiting for its next-MYT-day cutoff (same client
  // rule as truck rates): today's assignments still snapshot `points` above.
  pending_points: number | null;
  pending_points_effective: string | null; // MYT "YYYY-MM-DD"
  zone: { code: string; name: string } | null;
}

// The pay rules as the ENGINE states them (GET /incentives/rules). The
// Formula & Examples panel renders from this rather than restating the rules in
// the locale files, where they drifted: it said the daily deduction came off
// "the first trip of the day" (it comes off the day TOTAL, once, floored at
// zero) and called off-peak "Weekend / Holiday", which hid the evening case.
export interface IncentiveRules {
  /** Peak band start hour, MYT (inclusive). */
  peak_start_hour: number;
  /** Peak band end hour, MYT (exclusive) — at/after this is off-peak. */
  offpeak_cutoff_hour: number;
  /** Hour the incentive day rolls over, MYT. */
  daily_reset_hour: number;
  /** Which instant decides the band and the day. */
  rate_anchor: "delivery_confirm" | "pickup";
  /** Where the daily deduction lands. */
  deduction_scope: "day_total" | "first_trip";
  /** Points a repeat drop into the same zone earns that day. */
  repeat_zone_points: number;
  /** Where holidays come from — UWC's own calendar, not a national list. */
  holiday_source: "admin_calendar" | "national";
  /** Interplant pays in whole round trips (legs halved, rounded down). */
  interplant_round_trip_halving: boolean;
}

// Admin-managed public-holiday calendar (GET /holidays) — dates are MYT
// "YYYY-MM-DD" keys; a listed date pays the off-peak rate all day.
export interface PublicHoliday {
  id: string;
  date: string;
  name: string;
}

// Latest rate-change audit entry per record (GET /rates/audit) — drives the
// "last updated by X on DATE" note on the Incentive Rates page.
export interface RateAuditEntry {
  table_name: "Truck" | "DestinationRate";
  record_id: string; // truck plate, or destination rate id
  user_name: string;
  timestamp: string; // ISO
  action: string;
}

export interface MonthlyRow {
  month: string;
  label: string;
  trips: number;
  completed: number;
  incentive: number;
  external: number;
}

// Result of POST /trucks/reset-rates (restore truck rates to UWC spec defaults).
export interface RateResetChange {
  field: "entitled_claim_weekday" | "entitled_claim_offpeak" | "daily_deduction_points" | "max_pallets";
  from: number;
  to: number;
}
export interface RateResetResult {
  updated: { plate: string; changes: RateResetChange[] }[];
  already_at_spec: string[];
  skipped: string[];
  // Reset rate fields are staged to this MYT day (next-day cutoff);
  // max_pallets applies immediately.
  rates_effective_date: string;
}

export interface SchedulingConflictInfo {
  tripId: string;
  driverOrTruck: "driver" | "truck";
  plateOrDriverName: string;
  pickup: string;
}

export interface ApiErrorShape {
  error: { code: string; message: string; conflicts?: SchedulingConflictInfo[] };
}
