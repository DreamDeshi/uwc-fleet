// Shape of the API responses the app consumes. Money fields arrive from Prisma
// as strings (Decimal) or numbers; we keep them as `string | number | null` and
// coerce with Number() at display time.

export type Role = "admin" | "driver" | "requestor";
export type UserStatus = "pending_approval" | "active" | "disabled";

// UI languages: English, Bahasa Malaysia, Simplified Chinese.
export const SUPPORTED_LANGUAGES = ["en", "ms", "zh"] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

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
  address_1?: string | null;
  address_2?: string | null;
  postal_code?: string | null;
  area?: string | null;
  state?: string | null;
  zone_code: string;
  zone?: { code: string; name: string } | null;
  // Geocoded building position. The API has always shipped these (tripInclude
  // sends the whole consignee row) — they were simply never declared here, so
  // the driver's Navigate button fell back to a zone centroid.
  //
  // NULL IS THE GATE. The geocode scripts apply the precision gate at WRITE
  // time (geocode-google.ts: only ROOFTOP/RANGE_INTERPOLATED survive, and
  // duplicate-coordinate rows are demoted) and store NULL coordinates for
  // anything coarse. So a non-null pair is a real building; null means fall
  // back to the zone. Readers must NOT re-derive this from geocode_match_type:
  // that column holds two different vocabularies (Geoapify's `full_match`…,
  // Google's `ROOFTOP`…) depending on which script last wrote the row.
  latitude?: number | null;
  longitude?: number | null;
  geocode_match_type?: string | null;
}

export interface CargoDetail {
  id?: string;
  pallet_type: string;
  quantity: number;
  cartons?: number | null;
  custom_size?: string | null;
  // Q10 structured dimensions in feet for crate/rack/custom (canonical string in
  // custom_size). Legacy custom rows carry a free-text custom_size with these null.
  width_ft?: number | null;
  length_ft?: number | null;
  estimated_pallets?: number | null;
  remark?: string | null;
  // Item 3 multi-pickup (Inter-Plant only): which UWC plant this cargo line
  // was picked up from. Absent/null = today's single hardcoded origin.
  pickup_consignee_id?: string | null;
  // Resolved name (minimal select, id + company_name only) — display only.
  pickup_consignee?: { id: string; company_name: string } | null;
}

export interface TripStop {
  id: string;
  trip_id: string;
  sequence: number;
  consignee_id: string;
  status: StopStatus;
  arrived_at: string | null;
  delivered_at: string | null;
  pod_photo: string | null;
  // Server receipt time of the POD upload (IM6). NULL = unknown, which is every
  // stop whose POD predates the column — render the untimed string, never a
  // substituted time.
  pod_uploaded_at?: string | null;
  // DEVICE-reported capture time (IM6 pair). Untrusted evidence, never a
  // pay input; NULL when the device did not say. Label it as device-reported.
  pod_captured_client_at?: string | null;
  do_uploaded: boolean;
  // K2 (Borang K2) customs document — uploaded for K2-zone stops (Q6). The
  // signed URL is set when the driver has uploaded it; `k2_form_ack` is the
  // legacy tick (grandfathered rows only).
  k2_photo: string | null;
  k2_form_ack: boolean;
  // Per-drop pay evidence, persisted at finalization (write-once). Null until
  // the trip finalizes (and on legacy pre-snapshot rows). The server has
  // always shipped these via tripInclude; the driver breakdown renders them.
  zone_points?: number | null;
  points_awarded?: number | null;
  was_repeat?: boolean | null;
  consignee?: Consignee;
  // Stop-attached exception headers, shipped by tripInclude so the app can tell
  // a SETTLED stop (reached, admin verified + resumed, paid under R3 Q11(a) —
  // nothing left to do) from an outstanding one. `status` alone cannot: a
  // settled stop is still "pending"/"arrived". See lib/stopSettled.
  // Optional because older API builds do not send it; absent → not settled,
  // which is the pre-Q11(a) behaviour.
  exceptions?: {
    current_state: string;
    resolution: string | null;
    actions?: { type: string }[];
  }[];
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

export type DocumentType = "do_photo" | "k2_form" | "other";

export interface TripDocument {
  id: string;
  trip_id: string;
  type: DocumentType;
  file_url: string;
  uploaded_at: string;
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
  /** Admin-approved (possibly edited) final amount — set at POD approval; the
   *  payable figure on `completed` trips is COALESCE(incentive_final,
   *  incentive_earned). Never set on other statuses. */
  incentive_final?: string | number | null;
  /** Mandatory server-side whenever incentive_final differs from the proposal
   *  — the admin's written justification. The server has always shipped it in
   *  the trip payload; the driver adjustment note renders it. */
  incentive_override_reason?: string | null;
  // Finalize-time pay evidence (write-once, with the per-stop points_awarded):
  // the RM/point actually paid and the deduction points actually subtracted.
  // Null = finalized pre-feature. The server has always shipped these.
  rate_used?: string | number | null;
  deduction_applied?: number | null;
  // R5 A2 (IM10) — points withheld because the day's interplant legs do not yet
  // make up whole round trips. 0 on customer/supplier work; null = finalized
  // before the column. This is what lets the breakdown explain a RM0 leg.
  round_trip_shortfall?: number | null;
  is_external: boolean;
  rejection_reason?: string | null;
  created_at: string;
  requestor?: { id: string; name: string; phone: string };
  driver?: { id: string; name: string; phone: string } | null;
  truck?: {
    plate: string;
    type: string;
    max_pallets: number;
    // Present on the trip detail payload (API returns the full truck); used to
    // estimate incentive before the trip is finalised. Decimal → string|number.
    entitled_claim_weekday?: string | number;
    entitled_claim_offpeak?: string | number;
    daily_deduction_points?: number; // pts subtracted once/day before rate
  } | null;
  route_type?: RouteType;
  stops?: TripStop[];
  cargo_details?: CargoDetail[];
  documents?: TripDocument[];
  // Present only on the GET /trips/:id detail response, not on list items.
  timeline?: TimelineStep[];
}

export interface IncentiveTrip {
  id: string;
  ticket_number: string;
  pickup_datetime: string;
  // First delivery confirm — the instant the rate tier and pay-day
  // attribution keyed on. Null on trips without a delivered stop record.
  delivered_at: string | null;
  incentive_earned: string | number | null;
  /**
   * True while this trip's incentive is PROPOSED but not yet approved by an
   * admin (trip status `pending_approval`) — the money exists but is NOT
   * payable. The server has always sent this (`GET /incentives/mine`) and
   * excludes such trips from `summary.total`; this field was missing here, so
   * the Earnings screen could not read it and rendered an unapproved proposal
   * as if it were paid. Never present pending money as earned.
   */
  pending: boolean;
  truck_plate: string | null;
  route_type: string | null;
  destination: string | null;
  distance_km: number;
  pallets: number;
}

export interface IncentiveSummary {
  summary: {
    month: string;
    total: number;
    trip_count: number;
    total_distance_km: number;
    avg_per_trip: number;
  };
  trips: IncentiveTrip[];
  /** True when the breakdown is the newest N only. The SUMMARY above is always
   *  complete for the month — it comes from its own query — so this affects the
   *  list and nothing else. Optional so an older API build simply reads false. */
  truncated?: boolean;
}

export interface ApiErrorShape {
  error: { code: string; message: string };
}
