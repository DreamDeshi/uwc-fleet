// The requestor shell, split by layout — mirrors the admin's split so the two
// apps feel the same on a PC:
//   WIDE (PC): a permanent left sidebar (RequestorSidebar) + full-width content,
//     same navy-gradient / yellow-active-pill identity as the admin sidebar.
//   NARROW (phone): the shipped bottom tab bar (RequestorTabs), untouched.
// BookingDetail stays on the parent RequestorStack so it opens over either shell.
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  createDrawerNavigator,
  type DrawerContentComponentProps,
} from "@react-navigation/drawer";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { useWide } from "../hooks/useWide";
import { colors, radius, type } from "../theme";
import { BrandLogo } from "../components/BrandLogo";
import { RequestorTabs } from "./RequestorTabs";
import { RequestorDashboardScreen } from "../screens/requestor/RequestorDashboardScreen";
import { BookingFormScreen } from "../screens/requestor/BookingFormScreen";
import { BookingListScreen } from "../screens/requestor/BookingListScreen";
import { AnalyticsScreen } from "../screens/requestor/AnalyticsScreen";
import { BookingDetailScreen } from "../screens/requestor/BookingDetailScreen";
import { ProfileScreen } from "../screens/shared/ProfileScreen";

type IoniconName = keyof typeof Ionicons.glyphMap;

// Route names MUST match RequestorTabParamList so every existing
// navigation.navigate("Home" | "NewBooking" | "BookingsTab" | …) keeps working
// whether the active shell is the drawer (wide) or the tabs (narrow).
const NAV: { route: string; labelKey: string; icon: IoniconName }[] = [
  { route: "Home", labelKey: "tabs.home", icon: "home-outline" },
  { route: "NewBooking", labelKey: "tabs.newBooking", icon: "add-circle-outline" },
  { route: "BookingsTab", labelKey: "tabs.bookings", icon: "list-outline" },
  { route: "Analytics", labelKey: "tabs.analytics", icon: "stats-chart-outline" },
  { route: "Profile", labelKey: "tabs.profile", icon: "person-outline" },
];

// Sidebar gradient matches the admin's (theme.gradients.sidebar): navy → deep navy.
const SIDEBAR_GRADIENT = ["#1A1F5E", "#10143F"] as const;

const Drawer = createDrawerNavigator();

function RequestorSidebar(props: DrawerContentComponentProps) {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const insets = useSafeAreaInsets();
  const current = props.state.routeNames[props.state.index];
  // A booking detail is opened from the Bookings list, so keep that nav item lit
  // while viewing one (BookingDetail isn't itself a sidebar destination).
  const active = current === "BookingDetail" ? "BookingsTab" : current;

  return (
    <LinearGradient colors={SIDEBAR_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 26, paddingBottom: insets.bottom + 16, flexGrow: 1 }}>
        {/* Brand mark (proper noun — not translated) */}
        <View style={styles.brand}>
          <BrandLogo white mark height={42} />
          <View>
            <Text style={styles.brandName}>UWC TRUCKING</Text>
            <Text style={styles.brandSub}>FLEET MANAGEMENT</Text>
          </View>
        </View>
        <View style={styles.rule} />

        {/* Nav */}
        <View style={{ flex: 1, paddingHorizontal: 12 }}>
          {NAV.map((item) => {
            const isActive = active === item.route;
            return (
              <Pressable
                key={item.route}
                onPress={() => props.navigation.navigate(item.route)}
                style={[styles.navItem, isActive && styles.navItemActive]}
              >
                <Ionicons name={item.icon} size={18} color={isActive ? colors.navy : "rgba(255,255,255,0.42)"} />
                <Text style={[styles.navLabel, isActive && styles.navLabelActive]}>{t(item.labelKey)}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.rule, { marginVertical: 8 }]} />

        {/* Sign out */}
        <View style={{ paddingHorizontal: 12 }}>
          <Pressable onPress={logout} style={styles.signOut}>
            <Ionicons name="log-out-outline" size={18} color="rgba(255,255,255,0.6)" />
            <Text style={styles.signOutText}>{t("profile.logout")}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

// The PC shell — only ever mounted on wide (see RequestorShell below).
function RequestorDrawerWide() {
  return (
    <Drawer.Navigator
      initialRouteName="Home"
      drawerContent={(props) => <RequestorSidebar {...props} />}
      screenOptions={{
        headerShown: false, // each requestor screen draws its own header
        drawerType: "permanent",
        drawerStyle: { width: 248, borderRightWidth: 0, backgroundColor: "transparent" },
      }}
    >
      <Drawer.Screen name="Home" component={RequestorDashboardScreen} />
      <Drawer.Screen name="NewBooking" component={BookingFormScreen} />
      <Drawer.Screen name="BookingsTab" component={BookingListScreen} />
      <Drawer.Screen name="Analytics" component={AnalyticsScreen} />
      <Drawer.Screen name="Profile" component={ProfileScreen} />
      {/* Not a sidebar item — opened from Home/Bookings. On PC it renders in the
          content area so the sidebar stays put (a booking never full-screens the
          app); on phone, BookingDetail lives on the parent stack instead. */}
      <Drawer.Screen name="BookingDetail" component={BookingDetailScreen} />
    </Drawer.Navigator>
  );
}

// Wide → sidebar drawer; narrow → the shipped bottom tabs (unchanged).
export function RequestorShell() {
  const wide = useWide();
  return wide ? <RequestorDrawerWide /> : <RequestorTabs />;
}

const styles = StyleSheet.create({
  brand: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingBottom: 20 },
  brandMark: { width: 42, height: 42, backgroundColor: colors.yellow, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  brandName: { fontSize: 15, fontWeight: "800", color: "#fff", letterSpacing: 0.4 },
  brandSub: { fontSize: 10.5, color: colors.yellow, fontWeight: "700", letterSpacing: 1.8, marginTop: 1 },
  rule: { height: 1, backgroundColor: "rgba(255,255,255,0.08)", marginHorizontal: 16, marginBottom: 6 },

  navItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10, marginBottom: 4 },
  navItemActive: {
    backgroundColor: colors.yellow,
    shadowColor: "#FFCC00",
    shadowOpacity: 0.55,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  navLabel: { color: "rgba(255,255,255,0.66)", fontWeight: "500", fontSize: type.md, flex: 1 },
  navLabelActive: { color: colors.navy, fontWeight: "800" },

  signOut: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.14)" },
  signOutText: { color: "rgba(255,255,255,0.6)", fontSize: type.md, fontWeight: "600" },

  userCard: { marginHorizontal: 12, marginTop: 8, padding: 12, backgroundColor: "rgba(255,255,255,0.07)", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)", borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.15)", borderWidth: 2, borderColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.white, fontSize: 13, fontWeight: "800" },
  userName: { fontSize: type.md, fontWeight: "600", color: "#fff" },
  userRole: { fontSize: type.xs, color: "rgba(255,255,255,0.45)", marginTop: 1 },
});
