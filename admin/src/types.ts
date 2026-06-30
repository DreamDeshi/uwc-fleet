// API response shapes (mirrors the Express + Prisma payloads at /api/v1).

export type Role = "admin" | "driver" | "requestor";
export type UserStatus = "pending_approval" | "active" | "disabled";
export type TripStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "assigned"
  | "in_progress"
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
}

export interface Department {
  id: string;
  name: string;
}

export interface Consignee {
  id: string;
  company_name: string;
  vendor_code: string | null;
  area: string | null;
  state: string | null;
  zone_code: string;
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
  incentive_earned: string | null;
  is_external: boolean;
  rejection_reason: string | null;
  // Phase 2: true when auto-dispatch couldn't place this booking. Self-clearing.
  // "Needs attention" UI shows for (status === "pending" && auto_dispatch_failed).
  auto_dispatch_failed: boolean;
  created_at: string;
  stops: TripStop[];
  cargo_details: CargoDetail[];
  documents?: TripDocument[];
  // Present only on the GET /trips/:id detail response, not on list items.
  timeline?: TimelineStep[];
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
  priority_zones: string[];
  operating_hours_start: string;
  operating_hours_end: string;
  insurance_expiry: string | null;
  permit_expiry: string | null;
  road_tax_expiry: string | null;
  is_available: boolean;
  status: "active" | "idle" | "maintenance";
  driver: TripParty | null;
  current_load: number;
  current_route: string | null;
  trips_today: number;
  alerts: TruckAlert[];
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
  stale: boolean; // no ping for >3 min — show as "signal lost"
}

export type DriverStatus = "on_trip" | "available" | "off_duty";

export interface DriverPerf {
  id: string;
  name: string;
  phone: string;
  account_status: UserStatus;
  status: DriverStatus;
  assigned_truck: { plate: string; max_pallets: number } | null;
  current_load: number; // pallets already on this driver's truck (active trips)
  scheduled_trips: number; // assigned-but-not-started trips queued for this driver
  trips_total: number;
  trips_this_month: number;
  trips_today: number;
  incentive_this_month: number;
  current_route: string | null;
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

export interface FuelSummary {
  log_count: number;
  total_litres: number;
  total_cost_rm: number;
  avg_cost_per_litre: number | null;
  total_km_covered: number;
  cost_per_km: number | null;
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
  zone: { code: string; name: string } | null;
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
