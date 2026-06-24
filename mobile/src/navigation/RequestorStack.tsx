import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RequestorStackParamList } from "./types";
import { RequestorTabs } from "./RequestorTabs";
import { BookingDetailScreen } from "../screens/requestor/BookingDetailScreen";

const Stack = createNativeStackNavigator<RequestorStackParamList>();

// Wraps the requestor tabs so BookingDetail can be pushed on top of whichever
// tab is active. Tapping a booking from Home or the Bookings list both open the
// same pushed screen, and "back" returns to the tab the user came from.
export function RequestorStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={RequestorTabs} />
      <Stack.Screen name="BookingDetail" component={BookingDetailScreen} />
    </Stack.Navigator>
  );
}
