import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { TripsStackParamList } from "./types";
import { TripListScreen } from "../screens/driver/TripListScreen";
import { TripDetailsScreen } from "../screens/driver/TripDetailsScreen";
import { ActiveTripScreen } from "../screens/driver/ActiveTripScreen";

const Stack = createNativeStackNavigator<TripsStackParamList>();

export function TripsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="TripList" component={TripListScreen} />
      <Stack.Screen name="TripDetails" component={TripDetailsScreen} />
      <Stack.Screen name="ActiveTrip" component={ActiveTripScreen} />
    </Stack.Navigator>
  );
}
