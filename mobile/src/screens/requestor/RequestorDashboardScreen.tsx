import React, { useMemo } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation, type CompositeNavigationProp } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { BookingFilter, RequestorStackParamList, RequestorTabParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { useTrips } from "../../hooks/queries";
import { useWide } from "../../hooks/useWide";
import { colors, layout, radius, shadow } from "../../theme";
import { Card } from "../../components/Card";
import { StatusBadge } from "../../components/StatusBadge";
import { LoadingState, ErrorState } from "../../components/States";
import { formatDate, formatTime } from "../../lib/format";
import { tripDestination, ORIGIN_LABEL } from "../../lib/trip";
import { initials } from "../../lib/format";
import { Trip } from "../../types";

// Home tab, but it also pushes BookingDetail onto the parent requestor stack.
type Nav = CompositeNavigationProp<
  BottomTabNavigationProp<RequestorTabParamList, "Home">,
  NativeStackNavigationProp<RequestorStackParamList>
>;

// Greeting that matches the time of day (mirrors the driver dashboard warmth).
function greetingKey(hour: number): "goodMorning" | "goodAfternoon" | "goodEvening" {
  if (hour < 12) return "goodMorning";
  if (hour < 18) return "goodAfternoon";
  return "goodEvening";
}

export function RequestorDashboardScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const wide = useWide();
  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();

  const { active, pending, recent, stats } = useMemo(() => {
    const list = (trips ?? []).slice().sort(
      (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
    );
    const active = list.find((tr) => tr.status === "in_progress" || tr.status === "assigned");
    const pending = list.find((tr) => tr.status === "pending" || tr.status === "approved");
    // Up to 8 (wide shows more; the phone column slices to 4 below).
    const recent = list.slice(0, 8);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTrips = list.filter((tr) => new Date(tr.created_at) >= monthStart);
    const stats = {
      total: monthTrips.length,
      completed: monthTrips.filter((tr) => tr.status === "completed").length,
      pending: monthTrips.filter((tr) => tr.status === "pending" || tr.status === "approved").length,
    };
    return { active, pending, recent, stats };
  }, [trips]);

  const openDetail = (tripId: string) => navigation.navigate("BookingDetail", { tripId });
  const openBookings = (filter: BookingFilter) => navigation.navigate("BookingsTab", { filter });
  const greeting = t(`requestor.${greetingKey(new Date().getHours())}`);

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  // ── Shared card fragments (identical markup, composed differently per layout) ──
  const ctaCard = (
    <TouchableOpacity style={styles.cta} activeOpacity={0.9} onPress={() => navigation.navigate("NewBooking")}>
      <View style={styles.ctaIcon}>
        <MaterialCommunityIcons name="truck" size={22} color={colors.blue} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.ctaTitle}>{t("requestor.whereTo")}</Text>
        <Text style={styles.ctaSub}>{t("requestor.tapToBook")}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.blue} />
    </TouchableOpacity>
  );

  const activeCard = active ? (
    <TouchableOpacity activeOpacity={0.9} onPress={() => openDetail(active.id)}>
      <View style={styles.activeCard}>
        <View style={styles.activeTop}>
          <Text style={styles.activeLabel}>{t("requestor.activeTrip")}</Text>
          <StatusBadge status={active.status} small />
        </View>
        <Text style={styles.activeTicket}>{active.ticket_number}</Text>
        <View style={styles.routeMini}>
          <View style={[styles.miniDot, { backgroundColor: colors.white }]} />
          <Text style={styles.miniPlace}>{ORIGIN_LABEL}</Text>
          <Text style={styles.miniArrow}>→</Text>
          <View style={[styles.miniDot, { backgroundColor: colors.yellow }]} />
          <Text style={styles.miniPlace}>{tripDestination(active)}</Text>
        </View>
        {active.driver ? (
          <View style={styles.driverRow}>
            <View style={styles.driverAvatar}>
              <Text style={styles.driverAvatarText}>{initials(active.driver.name)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.driverName}>{active.driver.name}</Text>
              <Text style={styles.driverPlate}>{active.truck_plate}</Text>
            </View>
            <Text style={styles.track}>{t("requestor.track")} →</Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  ) : null;

  const pendingCard = pending ? (
    <TouchableOpacity activeOpacity={0.9} onPress={() => openDetail(pending.id)}>
      <View style={styles.pendingCard}>
        <View style={styles.pendingStripe} />
        <View style={{ flex: 1, padding: 14 }}>
          <View style={styles.pendingHead}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="time-outline" size={16} color="#d97706" />
              <Text style={styles.pendingLabel}>{t("requestor.pendingApproval")}</Text>
            </View>
            <View style={styles.awaitPill}>
              <Text style={styles.awaitText}>{t("requestor.awaiting")}</Text>
            </View>
          </View>
          <Text style={styles.pendingTicket}>{pending.ticket_number}</Text>
          <Text style={styles.pendingRoute}>
            {ORIGIN_LABEL} → {tripDestination(pending)}
          </Text>
          <Text style={styles.pendingMeta} numberOfLines={1}>
            {pending.route_type?.name} · {formatDate(pending.pickup_datetime)}, {formatTime(pending.pickup_datetime)}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={{ alignSelf: "center", marginRight: 12 }} />
      </View>
    </TouchableOpacity>
  ) : null;

  const statsRow = (
    <View style={styles.statRow}>
      <StatBox value={stats.total} label={t("history.all")} color={colors.blue} bg={colors.tintBlue} onPress={() => openBookings("all")} />
      <StatBox value={stats.completed} label={t("history.completed")} color={colors.green} bg={colors.tintGreen} onPress={() => openBookings("completed")} />
      <StatBox value={stats.pending} label={t("requestor.pendingShort")} color="#d97706" bg={colors.tintYellow} onPress={() => openBookings("active")} />
    </View>
  );

  const recentCard = (limit: number) => {
    const rows = recent.slice(0, limit);
    if (rows.length === 0) {
      return (
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.emptyText}>{t("requestor.noBookings")}</Text>
        </Card>
      );
    }
    return (
      <Card style={{ marginTop: 12 }} padded={false}>
        {rows.map((tr, i) => (
          <TouchableOpacity
            key={tr.id}
            style={[styles.recentRow, i < rows.length - 1 && styles.divider]}
            onPress={() => openDetail(tr.id)}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.recentRoute}>{ORIGIN_LABEL} → {tripDestination(tr)}</Text>
              <Text style={styles.recentMeta}>{tr.ticket_number} · {formatDate(tr.pickup_datetime)}</Text>
            </View>
            <StatusBadge status={tr.status} small />
          </TouchableOpacity>
        ))}
      </Card>
    );
  };

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12, paddingBottom: wide ? 24 : 44 }, wide && styles.headerWide]}>
      <View style={wide ? styles.fillCol : styles.centerCol}>
        <View style={styles.headerTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greetingTime}>{greeting} 👋</Text>
            <Text style={styles.hi}>{user?.name ?? ""}</Text>
            {user?.department?.name ? (
              <View style={styles.deptRow}>
                <Ionicons name="business-outline" size={12} color="rgba(255,255,255,0.65)" />
                <Text style={styles.dept}>{user.department.name}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );

  // ── Wide (office PC) — two-column dashboard that uses the whole screen ──
  if (wide) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {header}
        <View style={styles.wideBody}>
          <View style={styles.wideRow}>
            {/* Left — the primary book action + whatever bookings are live now. */}
            <View style={styles.wideMain}>
              {ctaCard}
              <Text style={[styles.sectionTitle, { marginTop: 20 }]}>{t("requestor.currentBookings")}</Text>
              <View style={{ gap: 12, marginTop: 12 }}>
                {activeCard}
                {pendingCard}
                {!active && !pending ? (
                  <View style={styles.emptyBookings}>
                    <MaterialCommunityIcons name="truck-outline" size={30} color={colors.textFaint} />
                    <Text style={styles.emptyBookingsText}>{t("requestor.noActiveBookings")}</Text>
                  </View>
                ) : null}
              </View>
            </View>
            {/* Right — the glanceable month figures + a taller recent list. */}
            <View style={styles.wideSide}>
              <Text style={styles.sectionTitle}>{t("requestor.thisMonth")}</Text>
              {statsRow}
              <Text style={[styles.sectionTitle, { marginTop: 20 }]}>{t("requestor.recentActivity")}</Text>
              {recentCard(8)}
            </View>
          </View>
        </View>
      </ScrollView>
    );
  }

  // ── Narrow (phone) — the shipped single-column layout, unchanged ──
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
    >
      {header}

      {/* Grab-style CTA — real layout overlap (negative margin) instead of a
          translateY transform, which left a subpixel blue seam along the
          card's edge on react-native-web. */}
      <View style={styles.ctaWrap}>{ctaCard}</View>

      <View style={{ height: 16 }} />

      {active ? <View style={styles.section}>{activeCard}</View> : null}
      {pending ? <View style={styles.section}>{pendingCard}</View> : null}

      {/* This month stats */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("requestor.thisMonth")}</Text>
        {statsRow}
      </View>

      {/* Recent activity */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("requestor.recentActivity")}</Text>
        {recentCard(4)}
      </View>
    </ScrollView>
  );
}

function StatBox({ value, label, color, bg, onPress }: { value: number; label: string; color: string; bg: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.statBox, { backgroundColor: bg }]} activeOpacity={0.8} onPress={onPress}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  centerCol: { width: "100%", maxWidth: layout.content, alignSelf: "center" },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 44 },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  // Bigger, bolder greeting so the header reads balanced (owner feedback).
  greetingTime: { color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: "700" },
  hi: { color: colors.white, fontSize: 26, fontWeight: "800", marginTop: 3 },
  deptRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 },
  dept: { color: "rgba(255,255,255,0.7)", fontSize: 14 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.15)", borderWidth: 2, borderColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.white, fontSize: 15, fontWeight: "800" },
  ctaWrap: { paddingHorizontal: 20, marginTop: -28, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  cta: { backgroundColor: colors.white, borderRadius: radius.lg, padding: 14, flexDirection: "row", alignItems: "center", gap: 14, ...shadow.floating },
  ctaIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  ctaTitle: { fontSize: 16, fontWeight: "700", color: colors.navy },
  ctaSub: { fontSize: 14, color: colors.textFaint },
  section: { paddingHorizontal: 16, paddingTop: 12, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },

  // ── Wide dashboard scaffold (fills the content area beside the sidebar) ──
  headerWide: { paddingHorizontal: 28 },
  fillCol: { width: "100%" },
  wideBody: { width: "100%", paddingHorizontal: 28, paddingTop: 22 },
  wideRow: { flexDirection: "row", alignItems: "flex-start", gap: 24 },
  wideMain: { flex: 1.6 },
  wideSide: { flex: 1, maxWidth: 460 },
  emptyBookings: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, alignItems: "center", justifyContent: "center", paddingVertical: 34, gap: 10, ...shadow.card },
  emptyBookingsText: { fontSize: 14, color: colors.textMuted, fontWeight: "600" },

  // Owner call (feedback round 2): the dark navy active card and the dashed
  // pending card are the PREFERRED look — kept exactly as originally shipped.
  activeCard: { backgroundColor: colors.blueDark, borderRadius: radius.xl, padding: 18, ...shadow.card },
  activeTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  activeLabel: { fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 1 },
  activeTicket: { fontSize: 13, fontWeight: "700", color: "rgba(255,255,255,0.5)", marginBottom: 10 },
  routeMini: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  miniDot: { width: 8, height: 8, borderRadius: 4 },
  miniPlace: { fontSize: 14, fontWeight: "700", color: colors.white },
  miniArrow: { color: "rgba(255,255,255,0.3)" },
  driverRow: { flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.1)", paddingTop: 12 },
  driverAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" },
  driverAvatarText: { color: colors.yellow, fontSize: 12, fontWeight: "800" },
  driverName: { fontSize: 14, fontWeight: "600", color: colors.white },
  driverPlate: { fontSize: 13, color: "rgba(255,255,255,0.5)" },
  track: { fontSize: 13, color: "rgba(255,255,255,0.7)" },

  pendingCard: { backgroundColor: colors.white, borderRadius: radius.lg, flexDirection: "row", overflow: "hidden", borderWidth: 2, borderStyle: "dashed", borderColor: "#FFB74D" },
  pendingStripe: { width: 5, backgroundColor: colors.yellow },
  pendingHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  pendingLabel: { fontSize: 13, fontWeight: "700", color: "#d97706", textTransform: "uppercase" },
  awaitPill: { backgroundColor: "#fffbeb", paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  awaitText: { color: "#d97706", fontSize: 13, fontWeight: "700" },
  pendingTicket: { fontSize: 13, fontWeight: "700", color: colors.blue, marginBottom: 4 },
  pendingRoute: { fontSize: 14, fontWeight: "600", color: colors.navy },
  pendingMeta: { fontSize: 13, color: colors.textMuted, marginTop: 4 },

  statRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  statBox: { flex: 1, borderRadius: radius.md, padding: 14, alignItems: "center" },
  statValue: { fontSize: 26, fontWeight: "900" },
  statLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginTop: 3 },

  recentRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  recentRoute: { fontSize: 14, fontWeight: "600", color: colors.navy },
  recentMeta: { fontSize: 13, color: colors.textFaint, marginTop: 2 },
  emptyText: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },
});
