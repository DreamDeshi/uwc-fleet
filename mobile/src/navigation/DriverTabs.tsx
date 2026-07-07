import React from "react";
import { Platform } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { getFocusedRouteNameFromRoute, RouteProp } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { DriverTabParamList } from "./types";
import { colors } from "../theme";

// On web there's no safe-area inset and RN-Web under-reserves vertical space for
// the label row, so the labels were clipped. Give the bar more height + bottom
// padding on web; native keeps the original compact sizing.
const TAB_BAR_STYLE = {
  height: Platform.OS === "web" ? 72 : 60,
  paddingTop: 6,
  paddingBottom: Platform.OS === "web" ? 16 : 8,
} as const;
import { usePodOutboxFlush } from "../hooks/usePodOutbox";
import { DriverDashboardScreen } from "../screens/driver/DriverDashboardScreen";
import { TripsStack } from "./TripsStack";
import { EarningsScreen } from "../screens/driver/EarningsScreen";
import { MyPerformanceScreen } from "../screens/driver/MyPerformanceScreen";
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
  // POD offline outbox: deliveries completed on dead signal replay from here
  // (mount + reconnect + foreground + periodic), so they upload even after
  // the driver leaves the active-trip screen.
  usePodOutboxFlush();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: { fontSize: 12, fontWeight: "700" },
        tabBarStyle: TAB_BAR_STYLE,
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
        name="Performance"
        component={MyPerformanceScreen}
        options={{
          title: t("tabs.performance"),
          tabBarIcon: ({ color, size }) => <Ionicons name="trophy-outline" size={size} color={color} />,
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
