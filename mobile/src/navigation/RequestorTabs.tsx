import React from "react";
import { Platform } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { RequestorTabParamList } from "./types";
import { colors } from "../theme";

// On web there's no safe-area inset and RN-Web under-reserves vertical space for
// the label row, so the labels were clipped. Give the bar more height + bottom
// padding on web; native keeps the original compact sizing.
const TAB_BAR_STYLE = {
  height: Platform.OS === "web" ? 72 : 60,
  paddingTop: 6,
  paddingBottom: Platform.OS === "web" ? 16 : 8,
} as const;
import { RequestorDashboardScreen } from "../screens/requestor/RequestorDashboardScreen";
import { BookingFormScreen } from "../screens/requestor/BookingFormScreen";
import { BookingListScreen } from "../screens/requestor/BookingListScreen";
import { AnalyticsScreen } from "../screens/requestor/AnalyticsScreen";
import { ProfileScreen } from "../screens/shared/ProfileScreen";

const Tab = createBottomTabNavigator<RequestorTabParamList>();

export function RequestorTabs() {
  const { t } = useTranslation();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: "#999",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "700" },
        tabBarStyle: TAB_BAR_STYLE,
      }}
    >
      <Tab.Screen
        name="Home"
        component={RequestorDashboardScreen}
        options={{
          title: t("tabs.home"),
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="NewBooking"
        component={BookingFormScreen}
        options={{
          title: t("tabs.newBooking"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="add-circle" size={size + 4} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="BookingsTab"
        component={BookingListScreen}
        options={{
          title: t("tabs.bookings"),
          tabBarIcon: ({ color, size }) => <Ionicons name="list" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="Analytics"
        component={AnalyticsScreen}
        options={{
          title: t("tabs.analytics"),
          tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" size={size} color={color} />,
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
