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
export type BookingsStackParamList = {
  BookingList: undefined;
  BookingDetail: { tripId: string };
};

export type RequestorTabParamList = {
  Home: undefined;
  NewBooking: undefined;
  BookingsTab: NavigatorScreenParams<BookingsStackParamList>;
  Profile: undefined;
};
