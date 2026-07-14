import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RequestorStackParamList } from "./types";
import { RequestorShell } from "./RequestorDrawer";
import { BookingDetailScreen } from "../screens/requestor/BookingDetailScreen";

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
    </Stack.Navigator>
  );
}
