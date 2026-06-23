import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { getFocusedRouteNameFromRoute, RouteProp } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { DriverTabParamList } from "./types";
import { colors } from "../theme";
import { DriverDashboardScreen } from "../screens/driver/DriverDashboardScreen";
import { TripsStack } from "./TripsStack";
import { EarningsScreen } from "../screens/driver/EarningsScreen";
import { ProfileScreen } from "../screens/shared/ProfileScreen";

const Tab = createBottomTabNavigator<DriverTabParamList>();

// Hide the tab bar while the full-screen ActiveTrip map is open (Grab-style).
function tabBarStyleForTrips(route: RouteProp<DriverTabParamList, "TripsTab">) {
  const focused = getFocusedRouteNameFromRoute(route);
  if (focused === "ActiveTrip") return { display: "none" as const };
  return undefined;
}

export function DriverTabs() {
  const { t } = useTranslation();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: "#999",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "700" },
        tabBarStyle: { height: 60, paddingBottom: 8, paddingTop: 6 },
      }}
    >
      <Tab.Screen
        name="Home"
        component={DriverDashboardScreen}
        options={{
          title: t("tabs.home"),
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="TripsTab"
        component={TripsStack}
        options={({ route }) => ({
          title: t("tabs.trips"),
          tabBarStyle: tabBarStyleForTrips(route),
          tabBarIcon: ({ color, size }) => <Ionicons name="list" size={size} color={color} />,
        })}
      />
      <Tab.Screen
        name="Earnings"
        component={EarningsScreen}
        options={{
          title: t("tabs.earnings"),
          tabBarIcon: ({ color, size }) => <Ionicons name="cash-outline" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          title: t("tabs.profile"),
          tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}
