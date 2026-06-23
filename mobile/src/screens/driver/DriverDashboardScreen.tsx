import React, { useMemo } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { DriverTabParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { useTrips } from "../../hooks/queries";
import { colors, radius, shadow } from "../../theme";
import { Card } from "../../components/Card";
import { StatusBadge } from "../../components/StatusBadge";
import { LoadingState, ErrorState } from "../../components/States";
import { formatMoney, formatDate, formatTime, dayMonth } from "../../lib/format";
import { tripDestination, cargoSummary, ORIGIN_LABEL } from "../../lib/trip";
import { Trip } from "../../types";

type Nav = BottomTabNavigationProp<DriverTabParamList>;

export function DriverDashboardScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();

  const { active, todays, recentCompleted, assignedToday } = useMemo(() => {
    const list = trips ?? [];
    const active = list.find((tr) => tr.status === "in_progress");
    const upcoming = list
      .filter((tr) => tr.status === "assigned" || tr.status === "in_progress")
      .sort((a, b) => +new Date(a.pickup_datetime) - +new Date(b.pickup_datetime));
    const todayStr = new Date().toDateString();
    const assignedToday = upcoming.filter(
      (tr) => new Date(tr.pickup_datetime).toDateString() === todayStr
    ).length;
    const recentCompleted = list
      .filter((tr) => tr.status === "completed")
      .sort((a, b) => +new Date(b.pickup_datetime) - +new Date(a.pickup_datetime))
      .slice(0, 3);
    return { active, todays: upcoming[0], recentCompleted, assignedToday };
  }, [trips]);

  const openDetails = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "TripDetails", params: { tripId } });
  const openActive = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "ActiveTrip", params: { tripId } });

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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={styles.logoBadge}>
              <MaterialCommunityIcons name="truck" size={18} color={colors.blue} />
            </View>
            <Text style={styles.brand}>UWC TRUCKING</Text>
          </View>
          <Ionicons name="notifications-outline" size={22} color={colors.white} />
        </View>
        <Text style={styles.date}>{formatDate(new Date())}</Text>
        <Text style={styles.greeting}>{t("driver.greeting", { name: firstName(user?.name) })} 👋</Text>
        <Text style={styles.sub}>{t("driver.tripsToday", { count: assignedToday })}</Text>
      </View>

      {/* Active trip card */}
      {active ? (
        <View style={styles.section}>
          <TouchableOpacity activeOpacity={0.9} onPress={() => openActive(active.id)}>
            <View style={styles.activeCard}>
              <View style={styles.activeTop}>
                <View>
                  <Text style={styles.activeLabel}>{t("driver.activeTrip")}</Text>
                  <Text style={styles.activeTicket}>{active.ticket_number}</Text>
                </View>
                <View style={styles.onRoute}>
                  <Text style={styles.onRouteText}>{t("trip.statusInProgress")}</Text>
                </View>
              </View>
              <View style={styles.routeMini}>
                <View style={[styles.miniDot, { backgroundColor: colors.white }]} />
                <Text style={styles.miniPlace}>{ORIGIN_LABEL}</Text>
                <Text style={styles.miniArrow}>→</Text>
                <View style={[styles.miniDot, { backgroundColor: colors.yellow }]} />
                <Text style={styles.miniPlace}>{tripDestination(active)}</Text>
              </View>
              <View style={styles.viewNavBtn}>
                <Ionicons name="navigate" size={16} color={colors.blue} />
                <Text style={styles.viewNavText}>{t("driver.viewNavigation")}</Text>
              </View>
            </View>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Today's assignment */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>{t("driver.todaysAssignment")}</Text>
        </View>
        {todays ? (
          <AssignmentCard trip={todays} onPress={() => openDetails(todays.id)} />
        ) : (
          <Card>
            <View style={styles.emptyRow}>
              <Ionicons name="cafe-outline" size={22} color={colors.textFaint} />
              <Text style={styles.emptyText}>{t("driver.noTripsToday")}</Text>
            </View>
          </Card>
        )}
      </View>

      {/* This month + recent completed */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("driver.recentCompleted")}</Text>
        <Card style={{ marginTop: 12 }}>
          {recentCompleted.length === 0 ? (
            <Text style={styles.emptyText}>{t("earnings.noEarnings")}</Text>
          ) : (
            recentCompleted.map((tr, i) => (
              <View
                key={tr.id}
                style={[styles.completedRow, i < recentCompleted.length - 1 && styles.divider]}
              >
                <View style={styles.checkCircle}>
                  <Ionicons name="checkmark" size={14} color={colors.green} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.completedRoute}>
                    {ORIGIN_LABEL} → {tripDestination(tr)}
                  </Text>
                  <Text style={styles.completedDate}>{formatDate(tr.pickup_datetime)}</Text>
                </View>
                <Text style={styles.completedRm}>{formatMoney(tr.incentive_earned)}</Text>
              </View>
            ))
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

function AssignmentCard({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.assignCard}>
      <View style={styles.assignHead}>
        <StatusBadge status={trip.status} small />
        {trip.truck_plate ? <Text style={styles.assignPlate}>{trip.truck_plate}</Text> : null}
        <Text style={styles.assignType}>{trip.route_type?.name}</Text>
      </View>
      <View style={styles.assignBody}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 }}>
          <Ionicons name="time-outline" size={14} color={colors.orange} />
          <Text style={styles.assignTime}>
            {formatDate(trip.pickup_datetime)} · {formatTime(trip.pickup_datetime)}
          </Text>
        </View>
        <Text style={styles.assignPlace}>{ORIGIN_LABEL}</Text>
        <Text style={styles.assignPlaceTo}>{tripDestination(trip)}</Text>
        <View style={styles.assignFooter}>
          <Text style={styles.assignCargo}>{cargoSummary(trip)}</Text>
          <Text style={styles.assignRm}>{formatMoney(trip.incentive_earned)}</Text>
        </View>
        <TouchableOpacity style={styles.detailBtn} onPress={onPress}>
          <Text style={styles.detailBtnText}>{t("driver.viewTripDetails")}</Text>
          <Ionicons name="arrow-forward" size={14} color={colors.white} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function firstName(name?: string) {
  return name ? name.split(" ")[0] : "";
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 20 },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  logoBadge: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: { color: colors.white, fontSize: 14, fontWeight: "700" },
  date: { color: "rgba(255,255,255,0.55)", fontSize: 12, marginTop: 12 },
  greeting: { color: colors.white, fontSize: 20, fontWeight: "700", marginTop: 4 },
  sub: { color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 2 },
  section: { paddingHorizontal: 16, paddingTop: 16 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },

  activeCard: { backgroundColor: colors.blueDark, borderRadius: radius.xl, padding: 18, ...shadow.card },
  activeTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 },
  activeLabel: { fontSize: 10, fontWeight: "700", color: "rgba(255,255,255,0.5)", letterSpacing: 1, textTransform: "uppercase" },
  activeTicket: { fontSize: 18, fontWeight: "800", color: colors.white, marginTop: 2 },
  onRoute: { backgroundColor: colors.yellow, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  onRouteText: { color: colors.blue, fontSize: 10, fontWeight: "800" },
  routeMini: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  miniDot: { width: 8, height: 8, borderRadius: 4 },
  miniPlace: { fontSize: 13, fontWeight: "600", color: colors.white },
  miniArrow: { color: "rgba(255,255,255,0.4)" },
  viewNavBtn: {
    backgroundColor: colors.white,
    height: 44,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  viewNavText: { color: colors.blue, fontSize: 14, fontWeight: "700" },

  assignCard: { backgroundColor: colors.white, borderRadius: radius.lg, overflow: "hidden", marginTop: 12, ...shadow.card },
  assignHead: { backgroundColor: colors.blue, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  assignPlate: { backgroundColor: "rgba(255,255,255,0.15)", color: colors.white, fontSize: 11, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  assignType: { marginLeft: "auto", color: colors.yellow, fontSize: 10, fontWeight: "700" },
  assignBody: { padding: 14 },
  assignTime: { fontSize: 12, fontWeight: "700", color: colors.orange },
  assignPlace: { fontSize: 13, fontWeight: "600", color: colors.navy },
  assignPlaceTo: { fontSize: 13, fontWeight: "600", color: colors.navy, marginTop: 6 },
  assignFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  assignCargo: { fontSize: 12, color: colors.textMuted },
  assignRm: { backgroundColor: colors.yellow, color: colors.navy, fontSize: 13, fontWeight: "800", paddingHorizontal: 14, paddingVertical: 4, borderRadius: radius.pill, overflow: "hidden" },
  detailBtn: {
    marginTop: 12,
    height: 42,
    backgroundColor: colors.blue,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  detailBtnText: { color: colors.white, fontSize: 13, fontWeight: "700" },

  emptyRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  emptyText: { fontSize: 14, color: colors.textMuted },

  completedRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  checkCircle: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.tintGreen, alignItems: "center", justifyContent: "center" },
  completedRoute: { fontSize: 13, fontWeight: "600", color: colors.navy },
  completedDate: { fontSize: 11, color: colors.textFaint, marginTop: 1 },
  completedRm: { fontSize: 14, fontWeight: "700", color: colors.green },
});
