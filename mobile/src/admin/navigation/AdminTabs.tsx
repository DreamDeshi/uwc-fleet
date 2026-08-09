// The NARROW (phone) admin shell — an app-like, thumb-reachable bottom tab
// bar that replaces the hamburger drawer (mobile polish pass, 14 Jul 2026):
//   HOME  — greeting home + dashboard merged (stats, attention, fleet map)
//   TRIPS — the dispatch board
//   FLEET — Drivers + Trucks behind a segment toggle
//   MORE  — Incentives / Reports / Consignees / User Management / Performance
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
import { useTruckAlerts } from "../hooks/queries";
import { colors } from "../theme";
import { AdminMobileHeader } from "../components/MobileHeader";
import { AdminHomeScreen } from "../screens/AdminHomeScreen";
import { TripsScreen } from "../screens/TripsScreen";
import { FleetScreen } from "../screens/FleetScreen";
import { IncentivesScreen } from "../screens/IncentivesScreen";
import { ReportsScreen } from "../screens/ReportsScreen";
import { SustainabilityScreen } from "../screens/SustainabilityScreen";
import { ConsigneesScreen } from "../screens/ConsigneesScreen";
import { UserManagementScreen } from "../screens/UserManagementScreen";
import { PerformanceScreen } from "../screens/PerformanceScreen";
import { IncentiveApprovalsScreen } from "../screens/IncentiveApprovalsScreen";
import { AuditLogScreen } from "../screens/AuditLogScreen";
import { AdminSearchScreen } from "../screens/AdminSearchScreen";
import { CalendarScreen } from "../screens/CalendarScreen";
import { AdminSettingsScreen } from "../screens/AdminSettingsScreen";
import { ExceptionsScreen } from "../screens/ExceptionsScreen";

// Same web-height fix as DriverTabs/RequestorTabs: RN-Web under-reserves
// space for the label row, so the bar is taller with more bottom padding on
// web; native keeps the compact sizing.
const TAB_BAR_STYLE = {
  height: Platform.OS === "web" ? 72 : 60,
  paddingTop: 6,
  paddingBottom: Platform.OS === "web" ? 16 : 8,
} as const;

// See DriverTabs for why minHeight is required: the taller BAR did not stop
// RN-Web clipping the label's own 11px box, which sliced every descender, and
// `height` cannot fix it because the Text class is display:inline.
const TAB_BAR_LABEL_STYLE = { fontSize: 12, lineHeight: 16, minHeight: 18, fontWeight: "700" } as const;

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// MORE is a stack so its five screens push with a back button while the tab
// bar stays put. Route names match the drawer's, so cross-screen
// navigate("AdminMore", { screen: ... }) works from any tab.
function MoreStack() {
  const { t } = useTranslation();
  // ⚠ BACK FROM A HOME TILE RETURNS TO HOME, not to this stack's root.
  // The home grid pushes into THIS stack, whose root is Settings — so a plain
  // goBack() landed the admin on Settings from a screen they opened while
  // standing on Home (owner, 9 Aug 2026). The tiles pass `fromHome`, and that
  // case switches tabs instead of popping one level.
  //
  // popToTop() first: otherwise the pushed screen stays on this stack, and the
  // next tap on the Settings tab reopens Reports instead of Settings.
  const header = (props: NativeStackHeaderProps) => {
    const fromHome = (props.route.params as { fromHome?: boolean } | undefined)?.fromHome === true;
    const back = fromHome
      ? () => {
          props.navigation.popToTop();
          props.navigation.getParent()?.navigate("AdminHome");
        }
      : props.back
        ? () => props.navigation.goBack()
        : undefined;
    return <AdminMobileHeader title={props.options.title ?? ""} onBack={back} />;
  };
  return (
    <Stack.Navigator screenOptions={{ header }}>
      {/* Titled "Settings" to MATCH the wide sidebar — this screen was the
          same AdminSettingsScreen under TWO names ("Profile" here, "Settings"
          on desktop), the core of the profile-vs-settings muddle.
          headerShown:false because the screen now draws its OWN blue identity
          header, the same one the driver/requestor Profile draws — the nav
          header on top of it would stack two blue bars. */}
      <Stack.Screen
        name="MoreHome"
        component={AdminSettingsScreen}
        options={{ title: t("admin.titles.settings"), headerShown: false }}
      />
      <Stack.Screen name="AdminIncentiveApprovals" component={IncentiveApprovalsScreen} options={{ title: t("admin.titles.incentiveApprovals") }} />
      <Stack.Screen name="AdminIncentives" component={IncentivesScreen} options={{ title: t("admin.titles.incentives") }} />
      <Stack.Screen name="AdminReports" component={ReportsScreen} options={{ title: t("admin.titles.reports") }} />
      <Stack.Screen name="AdminSustainability" component={SustainabilityScreen} options={{ title: t("admin.titles.sustainability") }} />
      <Stack.Screen name="AdminConsignees" component={ConsigneesScreen} options={{ title: t("admin.titles.consignees") }} />
      <Stack.Screen name="AdminUsers" component={UserManagementScreen} options={{ title: t("admin.users.title") }} />
      <Stack.Screen name="AdminPerformance" component={PerformanceScreen} options={{ title: t("admin.titles.performance") }} />
      <Stack.Screen name="AdminCalendar" component={CalendarScreen} options={{ title: t("admin.titles.calendar") }} />
      <Stack.Screen name="AdminSearch" component={AdminSearchScreen} options={{ title: t("admin.search.title") }} />
      <Stack.Screen name="AdminAudit" component={AuditLogScreen} options={{ title: t("admin.audit.title") }} />
      <Stack.Screen name="AdminExceptions" component={ExceptionsScreen} options={{ title: t("exception.laneTitle") }} />
      <Stack.Screen name="AdminSettings" component={AdminSettingsScreen} options={{ title: t("admin.titles.settings") }} />
    </Stack.Navigator>
  );
}

export function AdminTabs() {
  const { t } = useTranslation();
  // FLEET tab badge — truck document-expiry alerts. (The old MORE-tab approval
  // badges moved onto the home grid's POD Approvals / Users tiles.)
  const truckAlerts = useTruckAlerts();
  const truckAlertCount = truckAlerts.data?.length ?? 0;

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: TAB_BAR_LABEL_STYLE,
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
          title: t("admin.nav.settings"),
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}
