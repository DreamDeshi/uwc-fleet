import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { BookingsStackParamList } from "./types";
import { BookingListScreen } from "../screens/requestor/BookingListScreen";
import { BookingDetailScreen } from "../screens/requestor/BookingDetailScreen";

const Stack = createNativeStackNavigator<BookingsStackParamList>();

export function BookingsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="BookingList" component={BookingListScreen} />
      <Stack.Screen name="BookingDetail" component={BookingDetailScreen} />
    </Stack.Navigator>
  );
}
