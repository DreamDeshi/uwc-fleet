// Shape of the API responses the app consumes. Money fields arrive from Prisma
// as strings (Decimal) or numbers; we keep them as `string | number | null` and
// coerce with Number() at display time.

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

export interface Me {
  id: string;
  phone: string;
  name: string;
  employee_number: string | null;
  role: Role;
  status: UserStatus;
  language_pref: string;
  department: { id: string; name: string } | null;
  assigned_truck: { plate: string; type: string; max_pallets: number } | null;
}

export interface Department {
  id: string;
  name: string;
}

export interface RouteType {
  id: string;
  name: string;
}

export interface Consignee {
  id: string;
  company_name: string;
  vendor_code?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  area?: string | null;
  state?: string | null;
  zone_code: string;
  zone?: { code: string; name: string } | null;
}

export interface CargoDetail {
  id?: string;
  pallet_type: string;
  quantity: number;
  cartons?: number | null;
  custom_size?: string | null;
  remark?: string | null;
}

export interface TripStop {
  id: string;
  trip_id: string;
  sequence: number;
  consignee_id: string;
  status: StopStatus;
  arrived_at: string | null;
  delivered_at: string | null;
  do_uploaded: boolean;
  k2_form_ack: boolean;
  consignee?: Consignee;
}

export interface Trip {
  id: string;
  ticket_number: string;
  requestor_id: string;
  driver_id: string | null;
  truck_plate: string | null;
  route_type_id: string;
  status: TripStatus;
  pickup_datetime: string;
  incentive_earned: string | number | null;
  is_external: boolean;
  created_at: string;
  requestor?: { id: string; name: string; phone: string };
  driver?: { id: string; name: string; phone: string } | null;
  truck?: { plate: string; type: string; max_pallets: number } | null;
  route_type?: RouteType;
  stops?: TripStop[];
  cargo_details?: CargoDetail[];
}

export interface IncentiveTrip {
  id: string;
  ticket_number: string;
  pickup_datetime: string;
  incentive_earned: string | number | null;
  truck_plate: string | null;
  route_type: string | null;
  destination: string | null;
}

export interface IncentiveSummary {
  summary: { month: string; total: number; trip_count: number };
  trips: IncentiveTrip[];
}

export interface ApiErrorShape {
  error: { code: string; message: string };
}
