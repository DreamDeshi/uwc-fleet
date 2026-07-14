// The in-app admin shell, split by layout (mobile polish pass, 14 Jul 2026):
//   WIDE (PC): the react-navigation drawer below — permanent 248px sidebar,
//   the web admin's visual identity (navy gradient, grouped nav, the
//   corporate-yellow active pill). Untouched by the mobile pass.
//   NARROW (phone): the bottom tab bar (AdminTabs) — the hamburger drawer
//   is gone on phones; HOME/TRIPS/FLEET/MORE are thumb-reachable.
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  createDrawerNavigator,
  type DrawerContentComponentProps,
  type DrawerHeaderProps,
} from "@react-navigation/drawer";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import { useDashboard, usePendingUsers, useTruckAlerts } from "../hooks/queries";
import { colors, font, gradients, radius } from "../theme";
import { formatFullDate } from "../lib/format";
import { Avatar } from "../components/ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { installAdminWebFonts, adminFontScope } from "../platform/webFonts";
import { AdminTabs } from "./AdminTabs";
import { AdminHomeScreen } from "../screens/AdminHomeScreen";
import { ApprovalsScreen } from "../screens/ApprovalsScreen";
import { ConsigneesScreen } from "../screens/ConsigneesScreen";
import { PerformanceScreen } from "../screens/PerformanceScreen";
import { DriversScreen } from "../screens/DriversScreen";
import { TrucksScreen } from "../screens/TrucksScreen";
import { ReportsScreen } from "../screens/ReportsScreen";
import { IncentivesScreen } from "../screens/IncentivesScreen";
import { TripsScreen } from "../screens/TripsScreen";

type IoniconName = keyof typeof Ionicons.glyphMap;

interface NavItem {
  route: string;
  labelKey: string;
  icon: IoniconName;
}

// The full sidebar shape (mirrors the web admin's three groups). Items whose
// screen isn't registered yet show disabled — they light up as phases land.
const NAV_GROUPS: { headingKey: string; items: NavItem[] }[] = [
  { headingKey: "admin.navGroups.overview", items: [{ route: "AdminDashboard", labelKey: "admin.nav.dashboard", icon: "grid-outline" }] },
  {
    headingKey: "admin.navGroups.operations",
    items: [
      { route: "AdminTrips", labelKey: "admin.nav.trips", icon: "flash-outline" },
      { route: "AdminDrivers", labelKey: "admin.nav.drivers", icon: "person-outline" },
      { route: "AdminTrucks", labelKey: "admin.nav.trucks", icon: "bus-outline" },
      { route: "AdminPerformance", labelKey: "admin.nav.performance", icon: "trophy-outline" },
    ],
  },
  {
    headingKey: "admin.navGroups.administration",
    items: [
      { route: "AdminIncentives", labelKey: "admin.nav.incentives", icon: "cash-outline" },
      { route: "AdminApprovals", labelKey: "admin.nav.approvals", icon: "person-add-outline" },
      { route: "AdminConsignees", labelKey: "admin.nav.consignees", icon: "business-outline" },
      { route: "AdminReports", labelKey: "admin.nav.reports", icon: "bar-chart-outline" },
    ],
  },
];

const Drawer = createDrawerNavigator();

function AdminDrawerContent(props: DrawerContentComponentProps) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  // Nav badges (old-admin parity): pending-approvals count on User
  // Approvals, expiring-documents count on Truck Management.
  const pending = usePendingUsers();
  const truckAlerts = useTruckAlerts();
  const pendingCount = pending.data?.length ?? 0;
  const truckAlertCount = truckAlerts.data?.length ?? 0;
  const active = props.state.routeNames[props.state.index];
  const registered = new Set(props.state.routeNames);

  return (
    <LinearGradient colors={gradients.sidebar} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 26, paddingBottom: insets.bottom + 16, flexGrow: 1 }}>
        {/* Brand mark (proper noun — not translated) */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingBottom: 20 }}>
          <View
            style={{
              width: 42,
              height: 42,
              backgroundColor: colors.yellow,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="bus" size={22} color={colors.blue} />
          </View>
          <View>
            <Text style={{ fontSize: 15, fontWeight: "800", color: "#fff", letterSpacing: 0.4 }}>UWC TRUCKING</Text>
            <Text style={{ fontSize: 10.5, color: colors.yellow, fontWeight: "700", letterSpacing: 1.8 }}>FLEET MANAGEMENT</Text>
          </View>
        </View>
        <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.08)", marginHorizontal: 16, marginBottom: 6 }} />

        {/* Grouped nav */}
        <View style={{ flex: 1, paddingHorizontal: 12 }}>
          {NAV_GROUPS.map((g) => (
            <View key={g.headingKey}>
              <Text
                style={{
                  fontSize: 11.5,
                  fontWeight: "800",
                  letterSpacing: 1.8,
                  color: "rgba(255,255,255,0.32)",
                  paddingHorizontal: 10,
                  paddingTop: 14,
                  paddingBottom: 7,
                  textTransform: "uppercase",
                }}
              >
                {t(g.headingKey)}
              </Text>
              {g.items.map((item) => {
                const enabled = registered.has(item.route);
                const isActive = active === item.route;
                return (
                  <Pressable
                    key={item.route}
                    disabled={!enabled}
                    onPress={() => props.navigation.navigate(item.route)}
                    style={[
                      {
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        paddingVertical: 10,
                        paddingHorizontal: 12,
                        borderRadius: 10,
                        marginBottom: 3,
                        // The active page is unmistakable: the corporate-yellow
                        // pill with navy ink (web-admin sidebar identity).
                        backgroundColor: isActive ? colors.yellow : "transparent",
                        opacity: enabled ? 1 : 0.35,
                      },
                      // The pill's soft same-hue glow from the web admin (PC).
                      isActive && mode === "wide" && {
                        shadowColor: "#FFCC00",
                        shadowOpacity: 0.55,
                        shadowRadius: 18,
                        shadowOffset: { width: 0, height: 8 },
                      },
                    ]}
                  >
                    <Ionicons name={item.icon} size={18} color={isActive ? colors.navy : "rgba(255,255,255,0.38)"} />
                    <Text
                      style={{
                        color: isActive ? colors.navy : "rgba(255,255,255,0.62)",
                        fontWeight: isActive ? "800" : "500",
                        fontSize: font.md,
                        flex: 1,
                      }}
                    >
                      {t(item.labelKey)}
                    </Text>
                    {/* Count badges — approvals (yellow/navy swap on active) and
                        truck document alerts (red), exactly like the old admin. */}
                    {item.route === "AdminApprovals" && pendingCount > 0 && (
                      <View
                        style={{
                          backgroundColor: isActive ? colors.navy : colors.yellow,
                          borderRadius: radius.pill,
                          paddingVertical: 1,
                          paddingHorizontal: 7,
                        }}
                      >
                        <Text style={{ color: isActive ? colors.yellow : colors.navy, fontSize: font.xs, fontWeight: "800" }}>
                          {pendingCount}
                        </Text>
                      </View>
                    )}
                    {item.route === "AdminTrucks" && truckAlertCount > 0 && (
                      <View style={{ backgroundColor: colors.red, borderRadius: radius.pill, paddingVertical: 1, paddingHorizontal: 7 }}>
                        <Text style={{ color: "#fff", fontSize: font.xs, fontWeight: "800" }}>{truckAlertCount}</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.08)", marginHorizontal: 16, marginVertical: 8 }} />

        {/* Sign out (same key the rest of the app uses) */}
        <View style={{ paddingHorizontal: 12 }}>
          <Pressable
            onPress={logout}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.14)",
            }}
          >
            <Ionicons name="log-out-outline" size={18} color="rgba(255,255,255,0.6)" />
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: font.md, fontWeight: "600" }}>{t("admin.signOut")}</Text>
          </Pressable>
        </View>

        {/* Signed-in admin card */}
        <View
          style={{
            marginHorizontal: 12,
            marginTop: 8,
            padding: 12,
            backgroundColor: "rgba(255,255,255,0.07)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.09)",
            borderRadius: 12,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Avatar name={user?.name} size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: font.md, fontWeight: "600", color: "#fff" }}>
              {user?.name ?? "—"}
            </Text>
            <Text style={{ fontSize: font.xs, color: "rgba(255,255,255,0.45)" }}>{t("admin.roleLabel")}</Text>
          </View>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

// Route → header subtitle (the old admin's pageTitles map), i18n'd.
const SUBTITLE_KEYS: Record<string, string> = {
  AdminDashboard: "admin.subtitles.dashboard",
  AdminTrips: "admin.subtitles.trips",
  AdminDrivers: "admin.subtitles.drivers",
  AdminPerformance: "admin.subtitles.performance",
  AdminTrucks: "admin.subtitles.trucks",
  AdminIncentives: "admin.subtitles.incentives",
  AdminApprovals: "admin.subtitles.approvals",
  AdminConsignees: "admin.subtitles.consignees",
  AdminReports: "admin.subtitles.reports",
};

// Header — split by layout:
//   WIDE (PC): the old web admin's header exactly — gradient bar, 4px yellow
//   underline, 21px title + subtitle, date pill, alert bell with badge.
//   NARROW: flat corporate blue matching the driver/requestor headers (the
//   "no yellow underline on mobile headers" ruling), hamburger included.
function AdminHeader({ navigation, options, route }: DrawerHeaderProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  const dashboard = useDashboard();

  if (mode === "wide") {
    const subtitleKey = SUBTITLE_KEYS[route.name];
    const alertCount = dashboard.data?.alerts ?? 0;
    return (
      <LinearGradient colors={gradients.header} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
        <View
          style={{
            paddingTop: insets.top,
            height: insets.top + 66,
            paddingHorizontal: 28,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            borderBottomWidth: 4,
            borderBottomColor: colors.yellow,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: font.xl, fontWeight: "800", color: "#fff", letterSpacing: -0.2 }}>
              {options.title ?? ""}
            </Text>
            {subtitleKey ? (
              <Text numberOfLines={1} style={{ fontSize: font.sm, color: "rgba(255,255,255,0.65)", marginTop: -1 }}>
                {t(subtitleKey)}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View
              style={{
                backgroundColor: "rgba(255,255,255,0.12)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.14)",
                borderRadius: radius.pill,
                paddingVertical: 6,
                paddingHorizontal: 13,
              }}
            >
              <Text style={{ fontSize: font.sm, fontWeight: "600", color: "rgba(255,255,255,0.85)" }}>
                {formatFullDate(new Date())}
              </Text>
            </View>
            <View>
              <View
                style={{
                  backgroundColor: "rgba(255,255,255,0.12)",
                  borderRadius: 10,
                  width: 40,
                  height: 40,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="notifications-outline" size={18} color="#fff" />
              </View>
              {alertCount > 0 && (
                <View
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    minWidth: 16,
                    height: 16,
                    paddingHorizontal: 4,
                    backgroundColor: colors.red,
                    borderRadius: 8,
                    borderWidth: 1.5,
                    borderColor: colors.blue,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>{alertCount}</Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </LinearGradient>
    );
  }

  return (
    <View style={{ backgroundColor: colors.blue }}>
      <View
        style={{
          paddingTop: insets.top,
          height: insets.top + 60,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        {mode === "narrow" && (
          <Pressable
            onPress={() => navigation.toggleDrawer()}
            accessibilityLabel="Open menu"
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              backgroundColor: "rgba(255,255,255,0.12)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="menu" size={20} color="#fff" />
          </Pressable>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "800", color: "#fff", letterSpacing: -0.2 }}>
            {options.title ?? ""}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function AdminNavigator() {
  const mode = useLayoutMode();
  // Web: load Inter (the old admin's typeface) and scope it to this subtree
  // via [data-uwc-admin] — driver/requestor keep the system font. Idempotent.
  installAdminWebFonts();
  return (
    <View style={{ flex: 1 }} {...adminFontScope}>
      {mode === "wide" ? <AdminDrawerWide /> : <AdminTabs />}
    </View>
  );
}

// The PC shell — only ever mounted on wide, code unchanged from the
// pre-tab-bar era so the sidebar admin stays pixel-identical.
function AdminDrawerWide() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  return (
      <Drawer.Navigator
      // Admins land on the greeting home (the app-native landing shared with
      // the driver/requestor design language); Phase 3 grows it into the
      // full dashboard.
      initialRouteName="AdminDashboard"
      drawerContent={(props) => <AdminDrawerContent {...props} />}
      screenOptions={{
        header: (props) => <AdminHeader {...props} />,
        drawerType: mode === "wide" ? "permanent" : "front",
        drawerStyle: { width: 248, borderRightWidth: 0, backgroundColor: "transparent" },
        overlayColor: "rgba(16,24,40,0.5)",
      }}
    >
      {/* Only ported screens are registered; NAV_GROUPS entries without a
          registered route render disabled in the drawer (see above). */}
      <Drawer.Screen
        name="AdminDashboard"
        component={AdminHomeScreen}
        // Narrow: the greeting home draws its own header (hamburger
        // included) — no nav header on top of it. Wide: the dashboard uses
        // the standard flat-blue header like every other screen.
        options={{ title: t("admin.titles.dashboard"), headerShown: mode === "wide" }}
      />
      <Drawer.Screen
        name="AdminApprovals"
        component={ApprovalsScreen}
        options={{ title: t("admin.titles.approvals") }}
      />
      <Drawer.Screen
        name="AdminConsignees"
        component={ConsigneesScreen}
        options={{ title: t("admin.titles.consignees") }}
      />
      <Drawer.Screen
        name="AdminPerformance"
        component={PerformanceScreen}
        options={{ title: t("admin.titles.performance") }}
      />
      <Drawer.Screen
        name="AdminDrivers"
        component={DriversScreen}
        options={{ title: t("admin.titles.drivers") }}
      />
      <Drawer.Screen
        name="AdminTrucks"
        component={TrucksScreen}
        options={{ title: t("admin.titles.trucks") }}
      />
      <Drawer.Screen
        name="AdminReports"
        component={ReportsScreen}
        options={{ title: t("admin.titles.reports") }}
      />
      <Drawer.Screen
        name="AdminIncentives"
        component={IncentivesScreen}
        options={{ title: t("admin.titles.incentives") }}
      />
      <Drawer.Screen
        name="AdminTrips"
        component={TripsScreen}
        options={{ title: t("admin.titles.trips") }}
      />
      </Drawer.Navigator>
  );
}
