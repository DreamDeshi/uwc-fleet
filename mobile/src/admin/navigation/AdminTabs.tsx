// The NARROW (phone) admin shell — an app-like, thumb-reachable bottom tab
// bar that replaces the hamburger drawer (mobile polish pass, 14 Jul 2026):
//   HOME  — greeting home + dashboard merged (stats, attention, fleet map)
//   TRIPS — the dispatch board
//   FLEET — Drivers + Trucks behind a segment toggle
//   MORE  — Incentives / Reports / Consignees / Approvals / Performance
//           as a native stack, plus sign-out
// Wide (PC) never mounts this — AdminNavigator keeps the permanent sidebar
// drawer there. Tab badges carry the drawer's signals: truck document
// alerts on FLEET (red), pending approvals on MORE (corporate yellow).
import React from "react";
import { Platform } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator, type NativeStackHeaderProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { usePendingUsers, useTruckAlerts } from "../hooks/queries";
import { colors } from "../theme";
import { AdminMobileHeader } from "../components/MobileHeader";
import { AdminHomeScreen } from "../screens/AdminHomeScreen";
import { TripsScreen } from "../screens/TripsScreen";
import { FleetScreen } from "../screens/FleetScreen";
import { MoreScreen } from "../screens/MoreScreen";
import { IncentivesScreen } from "../screens/IncentivesScreen";
import { ReportsScreen } from "../screens/ReportsScreen";
import { ConsigneesScreen } from "../screens/ConsigneesScreen";
import { ApprovalsScreen } from "../screens/ApprovalsScreen";
import { PerformanceScreen } from "../screens/PerformanceScreen";

// Same web-height fix as DriverTabs/RequestorTabs: RN-Web under-reserves
// space for the label row, so the bar is taller with more bottom padding on
// web; native keeps the compact sizing.
const TAB_BAR_STYLE = {
  height: Platform.OS === "web" ? 72 : 60,
  paddingTop: 6,
  paddingBottom: Platform.OS === "web" ? 16 : 8,
} as const;

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// MORE is a stack so its five screens push with a back button while the tab
// bar stays put. Route names match the drawer's, so cross-screen
// navigate("AdminMore", { screen: ... }) works from any tab.
function MoreStack() {
  const { t } = useTranslation();
  const header = (props: NativeStackHeaderProps) => (
    <AdminMobileHeader
      title={props.options.title ?? ""}
      onBack={props.back ? () => props.navigation.goBack() : undefined}
    />
  );
  return (
    <Stack.Navigator screenOptions={{ header }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} options={{ title: t("admin.titles.more") }} />
      <Stack.Screen name="AdminIncentives" component={IncentivesScreen} options={{ title: t("admin.titles.incentives") }} />
      <Stack.Screen name="AdminReports" component={ReportsScreen} options={{ title: t("admin.titles.reports") }} />
      <Stack.Screen name="AdminConsignees" component={ConsigneesScreen} options={{ title: t("admin.titles.consignees") }} />
      <Stack.Screen name="AdminApprovals" component={ApprovalsScreen} options={{ title: t("admin.titles.approvals") }} />
      <Stack.Screen name="AdminPerformance" component={PerformanceScreen} options={{ title: t("admin.titles.performance") }} />
    </Stack.Navigator>
  );
}

export function AdminTabs() {
  const { t } = useTranslation();
  // The drawer's nav badges, relocated to the tab bar.
  const pending = usePendingUsers();
  const truckAlerts = useTruckAlerts();
  const pendingCount = pending.data?.length ?? 0;
  const truckAlertCount = truckAlerts.data?.length ?? 0;

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
      {/* Home draws its own greeting header (no nav header). */}
      <Tab.Screen
        name="AdminHome"
        component={AdminHomeScreen}
        options={{
          title: t("admin.tabs.home"),
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="AdminTrips"
        component={TripsScreen}
        options={{
          title: t("admin.tabs.trips"),
          headerShown: true,
          header: () => <AdminMobileHeader title={t("admin.titles.trips")} />,
          tabBarIcon: ({ color, size }) => <Ionicons name="flash" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="AdminFleet"
        component={FleetScreen}
        options={{
          title: t("admin.tabs.fleet"),
          headerShown: true,
          header: () => <AdminMobileHeader title={t("admin.titles.fleet")} />,
          tabBarIcon: ({ color, size }) => <Ionicons name="bus" size={size} color={color} />,
          tabBarBadge: truckAlertCount > 0 ? truckAlertCount : undefined,
        }}
      />
      <Tab.Screen
        name="AdminMore"
        component={MoreStack}
        options={{
          title: t("admin.tabs.more"),
          tabBarIcon: ({ color, size }) => <Ionicons name="ellipsis-horizontal" size={size} color={color} />,
          tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
          // Approvals wear the corporate yellow/navy (drawer parity); truck
          // alerts on FLEET keep the default red.
          tabBarBadgeStyle: { backgroundColor: colors.yellow, color: colors.navy, fontWeight: "800" },
        }}
      />
    </Tab.Navigator>
  );
}
