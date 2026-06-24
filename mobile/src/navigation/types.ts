import type { NavigatorScreenParams } from "@react-navigation/native";

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

// ── Driver ────────────────────────────────────────────────────────────
export type TripsStackParamList = {
  TripList: undefined;
  TripDetails: { tripId: string };
  ActiveTrip: { tripId: string };
};

export type DriverTabParamList = {
  Home: undefined;
  TripsTab: NavigatorScreenParams<TripsStackParamList>;
  Earnings: undefined;
  Profile: undefined;
};

// ── Requestor ─────────────────────────────────────────────────────────
export type BookingFilter = "all" | "active" | "completed";

export type RequestorTabParamList = {
  Home: undefined;
  NewBooking: undefined;
  // Optional `filter` lets the dashboard's stat cards deep-link the Bookings
  // list straight to All / Active / Completed.
  BookingsTab: { filter?: BookingFilter } | undefined;
  Profile: undefined;
};

// BookingDetail lives ABOVE the tabs so it can be opened from any tab (Home or
// the Bookings list) and "back" returns to whichever tab you came from.
export type RequestorStackParamList = {
  Tabs: NavigatorScreenParams<RequestorTabParamList>;
  BookingDetail: { tripId: string };
};
