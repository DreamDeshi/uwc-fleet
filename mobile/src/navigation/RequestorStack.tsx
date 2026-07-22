import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RequestorStackParamList } from "./types";
import { RequestorShell } from "./RequestorDrawer";
import { BookingDetailScreen } from "../screens/requestor/BookingDetailScreen";
import { BookingFormScreen } from "../screens/requestor/BookingFormScreen";

const Stack = createNativeStackNavigator<RequestorStackParamList>();

// Wraps the requestor shell (a permanent sidebar on PC, bottom tabs on phone —
// see RequestorShell) so BookingDetail can be pushed on top of whichever screen
// is active. Tapping a booking from Home or the Bookings list both open the same
// pushed screen, and "back" returns to where you came from.
export function RequestorStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={RequestorShell} />
      <Stack.Screen name="BookingDetail" component={BookingDetailScreen} />
      {/* New Booking — no longer a bottom-nav tab; pushed over the tabs from the
          Home hero CTA and the Bookings "+". Same form component as EditBooking. */}
      <Stack.Screen name="NewBooking" component={BookingFormScreen} />
      {/* Same component as NewBooking; the tripId param flips it into edit mode
          (pending bookings only — the detail screen gates the button, the server
          enforces it). */}
      <Stack.Screen name="EditBooking" component={BookingFormScreen} />
    </Stack.Navigator>
  );
}
