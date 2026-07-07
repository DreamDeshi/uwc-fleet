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
import { colors, radius, shadow, statusColors } from "../../theme";
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
  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();

  const { active, pending, recent, stats } = useMemo(() => {
    const list = (trips ?? []).slice().sort(
      (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
    );
    const active = list.find((tr) => tr.status === "in_progress" || tr.status === "assigned");
    const pending = list.find((tr) => tr.status === "pending" || tr.status === "approved");
    const recent = list.slice(0, 4);
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

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
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
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(user?.name ?? "")}</Text>
          </View>
        </View>

      </View>

      {/* Grab-style CTA — real layout overlap (negative margin) instead of a
          translateY transform, which left a subpixel blue seam along the
          card's edge on react-native-web. */}
      <View style={styles.ctaWrap}>
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
      </View>

      <View style={{ height: 16 }} />

      {/* Active booking */}
      {active ? (
        <View style={styles.section}>
          <TouchableOpacity activeOpacity={0.9} onPress={() => openDetail(active.id)}>
            {/* Light surface with a status-colored accent bar — the heavy
                navy block read as a different design system from the rest
                of the screen (owner feedback, round 1). */}
            <View
              style={[
                styles.activeCard,
                { borderLeftColor: (statusColors[active.status] ?? statusColors.assigned).bg },
              ]}
            >
              <View style={styles.activeTop}>
                <Text style={styles.activeLabel}>{t("requestor.activeTrip")}</Text>
                <StatusBadge status={active.status} small />
              </View>
              <Text style={styles.activeTicket}>{active.ticket_number}</Text>
              <View style={styles.routeMini}>
                <View style={[styles.miniDot, { backgroundColor: colors.blue }]} />
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
        </View>
      ) : null}

      {/* Pending booking */}
      {pending ? (
        <View style={styles.section}>
          <TouchableOpacity activeOpacity={0.9} onPress={() => openDetail(pending.id)}>
            <View style={styles.pendingCard}>
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
                <Text style={styles.pendingMeta}>
                  {pending.route_type?.name} · {formatDate(pending.pickup_datetime)}, {formatTime(pending.pickup_datetime)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#ccc" style={{ alignSelf: "center", marginRight: 12 }} />
            </View>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* This month stats */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("requestor.thisMonth")}</Text>
        <View style={styles.statRow}>
          <StatBox value={stats.total} label={t("history.all")} color={colors.blue} bg={colors.tintBlue} onPress={() => openBookings("all")} />
          <StatBox value={stats.completed} label={t("history.completed")} color={colors.green} bg={colors.tintGreen} onPress={() => openBookings("completed")} />
          <StatBox value={stats.pending} label={t("requestor.pendingApproval")} color="#d97706" bg={colors.tintYellow} onPress={() => openBookings("active")} />
        </View>
      </View>

      {/* Recent activity */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("requestor.recentActivity")}</Text>
        {recent.length === 0 ? (
          <Card style={{ marginTop: 12 }}>
            <Text style={styles.emptyText}>{t("requestor.noBookings")}</Text>
          </Card>
        ) : (
          <Card style={{ marginTop: 12 }} padded={false}>
            {recent.map((tr, i) => (
              <TouchableOpacity
                key={tr.id}
                style={[styles.recentRow, i < recent.length - 1 && styles.divider]}
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
        )}
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
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 44 },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  // Bigger, bolder greeting so the header reads balanced (owner feedback).
  greetingTime: { color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: "700" },
  hi: { color: colors.white, fontSize: 26, fontWeight: "800", marginTop: 3 },
  deptRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 },
  dept: { color: "rgba(255,255,255,0.7)", fontSize: 14 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.15)", borderWidth: 2, borderColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.white, fontSize: 15, fontWeight: "800" },
  ctaWrap: { paddingHorizontal: 20, marginTop: -28 },
  cta: { backgroundColor: colors.white, borderRadius: radius.lg, padding: 14, flexDirection: "row", alignItems: "center", gap: 14, ...shadow.floating },
  ctaIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  ctaTitle: { fontSize: 16, fontWeight: "700", color: colors.navy },
  ctaSub: { fontSize: 14, color: colors.textFaint },
  section: { paddingHorizontal: 16, paddingTop: 12 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },

  activeCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderLeftWidth: 5, // accent color set inline from the trip's status
    ...shadow.card,
  },
  activeTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  activeLabel: { fontSize: 12, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1 },
  activeTicket: { fontSize: 13, fontWeight: "800", color: colors.blue, marginBottom: 10 },
  routeMini: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  miniDot: { width: 8, height: 8, borderRadius: 4 },
  miniPlace: { fontSize: 15, fontWeight: "700", color: colors.navy },
  miniArrow: { color: colors.textFaint },
  driverRow: { flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: 1, borderTopColor: colors.borderLight, paddingTop: 12 },
  driverAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  driverAvatarText: { color: colors.blue, fontSize: 12, fontWeight: "800" },
  driverName: { fontSize: 14, fontWeight: "600", color: colors.navy },
  driverPlate: { fontSize: 13, color: colors.textMuted },
  track: { fontSize: 13, fontWeight: "700", color: colors.blue },

  pendingCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    flexDirection: "row",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.borderLight,
    // Solid card with the pending-amber accent bar — same language as the
    // active card above (dashed outline dropped, owner feedback round 1).
    borderLeftWidth: 5,
    borderLeftColor: "#F59E0B",
    ...shadow.card,
  },
  pendingHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  pendingLabel: { fontSize: 13, fontWeight: "700", color: "#d97706", textTransform: "uppercase" },
  awaitPill: { backgroundColor: "#fffbeb", paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  awaitText: { color: "#d97706", fontSize: 13, fontWeight: "700" },
  pendingTicket: { fontSize: 13, fontWeight: "700", color: colors.blue, marginBottom: 4 },
  pendingRoute: { fontSize: 14, fontWeight: "600", color: colors.navy },
  pendingMeta: { fontSize: 13, color: "#888", marginTop: 4 },

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
