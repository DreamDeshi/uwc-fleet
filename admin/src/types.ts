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
  created_at: string;
  stops: TripStop[];
  cargo_details: CargoDetail[];
  documents?: TripDocument[];
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
  trips_total: number;
  trips_this_month: number;
  trips_today: number;
  incentive_this_month: number;
  current_route: string | null;
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
  alerts: number;
}

export interface DestinationRate {
  id: string;
  zone_code: string | null;
  location_name: string;
  points: number;
  zone: { code: string; name: string } | null;
}

export interface MonthlyRow {
  month: string;
  label: string;
  trips: number;
  completed: number;
  incentive: number;
  external: number;
}

export interface ApiErrorShape {
  error: { code: string; message: string };
}
