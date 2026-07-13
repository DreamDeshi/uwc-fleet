// The in-app admin shell: one react-navigation drawer that IS both layouts —
// a permanent 248px sidebar on wide screens (PC via Expo web), an off-canvas
// hamburger drawer on phones. Visual identity is the web admin's sidebar:
// navy gradient, grouped nav, the corporate-yellow active pill.
//
// Phase 0 registers only a placeholder home screen; Phase 1+ add the real
// screens by (1) registering them below and (2) adding their entry to
// NAV_GROUPS. Drawer items whose route isn't registered yet render disabled,
// so the sidebar's final shape is already in place.
//
// NOT routed from RootNavigator yet — the admin role keeps seeing the
// web-dashboard note until Phase 1 flips the branch.
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
import { colors, font, gradients } from "../theme";
import { Avatar } from "../components/ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { ApprovalsScreen } from "../screens/ApprovalsScreen";

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
                    style={{
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
                    }}
                  >
                    <Ionicons name={item.icon} size={18} color={isActive ? colors.navy : "rgba(255,255,255,0.38)"} />
                    <Text
                      style={{
                        color: isActive ? colors.navy : "rgba(255,255,255,0.62)",
                        fontWeight: isActive ? "800" : "500",
                        fontSize: font.md,
                      }}
                    >
                      {t(item.labelKey)}
                    </Text>
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
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: font.md, fontWeight: "600" }}>{t("profile.logout")}</Text>
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

// Header: the web admin's gradient bar with the yellow underline; hamburger
// appears only in narrow (off-canvas) mode.
function AdminHeader({ navigation, options }: DrawerHeaderProps) {
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  return (
    <LinearGradient colors={gradients.header} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
      <View
        style={{
          paddingTop: insets.top,
          height: insets.top + 60,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          borderBottomWidth: 4,
          borderBottomColor: colors.yellow,
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
    </LinearGradient>
  );
}

export function AdminNavigator() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  return (
    <Drawer.Navigator
      // Phase 1: no dashboard yet — admins land on the approval queue, the
      // most action-shaped of the live screens.
      initialRouteName="AdminApprovals"
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
        name="AdminApprovals"
        component={ApprovalsScreen}
        options={{ title: t("admin.nav.approvals") }}
      />
    </Drawer.Navigator>
  );
}
