import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { DriverTabParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { useTrips, useHolidaySet, useMyTruckFuel } from "../../hooks/queries";
import { colors, layout, radius, shadow } from "../../theme";
import { Card } from "../../components/Card";
import { StatusBadge } from "../../components/StatusBadge";
import { TripCard } from "../../components/TripCard";
import { LoadingState, ErrorState } from "../../components/States";
import { LogFuelModal } from "../../components/LogFuelModal";
import { formatMoney, formatDate, formatTime } from "../../lib/format";
import { tripDestination, cargoSummary, estimateIncentive, ORIGIN_LABEL } from "../../lib/trip";
import { DELIVERED_STATUSES } from "../../lib/tripStatus";
import { Trip } from "../../types";

type Nav = BottomTabNavigationProp<DriverTabParamList>;

export function DriverDashboardScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const [fuelOpen, setFuelOpen] = useState(false);
  const fuel = useMyTruckFuel(user?.assigned_truck?.plate);
  const lastFill = fuel.data?.logs?.[0];
  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();

  const { active, assigned, recentCompleted, assignedToday } = useMemo(() => {
    const list = trips ?? [];
    const byPickupAsc = (a: Trip, b: Trip) =>
      +new Date(a.pickup_datetime) - +new Date(b.pickup_datetime);
    const active = list.find((tr) => tr.status === "in_progress");
    // ALL assigned trips, earliest pickup first, so the driver sees the full
    // workload (not just the first). The in_progress trip, if any, is pinned
    // separately above as the Active Trip card.
    const assigned = list.filter((tr) => tr.status === "assigned").sort(byPickupAsc);
    const todayStr = new Date().toDateString();
    // Greeting count = today's workload: assigned + the active in_progress trip.
    const assignedToday = list.filter(
      (tr) =>
        (tr.status === "assigned" || tr.status === "in_progress") &&
        new Date(tr.pickup_datetime).toDateString() === todayStr
    ).length;
    // DELIVERED_STATUSES, not `=== "completed"`: a trip awaiting POD approval is
    // delivered. Filtering on `completed` alone meant the trip the driver had
    // JUST finished vanished from his dashboard entirely — not active, not
    // assigned, not recent — until an admin got around to approving it.
    const recentCompleted = list
      .filter((tr) => DELIVERED_STATUSES.includes(tr.status))
      .sort((a, b) => +new Date(b.pickup_datetime) - +new Date(a.pickup_datetime))
      .slice(0, 3);
    return { active, assigned, recentCompleted, assignedToday };
  }, [trips]);

  const openDetails = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "TripDetails", params: { tripId } });
  const openActive = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "ActiveTrip", params: { tripId } });

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  return (
    <>
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.centerCol}>
          <View style={styles.headerTop}>
            <Text style={styles.brand}>UWC TRUCKING</Text>
          </View>
          <Text style={styles.date}>{formatDate(new Date())}</Text>
          {/* Full name, not the first word — Mr. Teh 16 Jul: "Need show the
              driver full name in driver page" (the split showed just "Mohd"). */}
          <Text style={styles.greeting}>{t("driver.greeting", { name: user?.name ?? "" })} 👋</Text>
          <Text style={styles.sub}>{t("driver.tripsToday", { count: assignedToday })}</Text>
        </View>
      </View>

      {/* Quick action: log a fuel fill-up (moved here from Settings so it's
          one tap from the driver's home — logged often). */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.fuelBtn} onPress={() => setFuelOpen(true)} activeOpacity={0.85}>
          <View style={styles.fuelIcon}>
            <MaterialCommunityIcons name="gas-station" size={20} color={colors.blue} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.fuelTitle}>{t("profile.logFuel")}</Text>
            <Text style={styles.fuelSub} numberOfLines={1}>
              {user?.assigned_truck
                ? lastFill
                  ? `${user.assigned_truck.plate} · ${t("fuel.lastFillShort", { when: formatDate(lastFill.logged_at), litres: lastFill.liters })}`
                  : user.assigned_truck.plate
                : t("fuel.noTruck")}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
        </TouchableOpacity>
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

      {/* Today's assignments — every assigned trip, earliest pickup first.
          The first is highlighted as "Next up"; the rest sit under an Upcoming
          divider. When a trip is already in progress (pinned above) and nothing
          else is assigned, the section is omitted. */}
      {assigned.length > 0 ? (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>{t("driver.todaysAssignments")}</Text>
            <View style={styles.countPill}>
              <Text style={styles.countText}>{assigned.length}</Text>
            </View>
          </View>
          {assigned.map((tr, i) => (
            <React.Fragment key={tr.id}>
              {i === 1 ? <Text style={styles.upcomingLabel}>{t("driver.upcoming")}</Text> : null}
              <AssignmentCard trip={tr} isNext={i === 0} onPress={() => openDetails(tr.id)} />
            </React.Fragment>
          ))}
        </View>
      ) : !active ? (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>{t("driver.todaysAssignments")}</Text>
          </View>
          <Card>
            <View style={styles.emptyRow}>
              <Ionicons name="cafe-outline" size={22} color={colors.textFaint} />
              <Text style={styles.emptyText}>{t("driver.noTripsToday")}</Text>
            </View>
          </Card>
        </View>
      ) : null}

      {/* This month + recent completed */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("driver.recentCompleted")}</Text>
        {recentCompleted.length === 0 ? (
          <Card style={{ marginTop: 12 }}>
            <Text style={styles.emptyText}>{t("earnings.noEarnings")}</Text>
          </Card>
        ) : (
          <View style={{ marginTop: 12 }}>
            {recentCompleted.map((tr) => (
              <TripCard
                key={tr.id}
                trip={tr}
                meta={`${tr.ticket_number} · ${cargoSummary(tr)}`}
                showIncentive
                onPress={() => openDetails(tr.id)}
              />
            ))}
          </View>
        )}
      </View>
    </ScrollView>
    <LogFuelModal
      visible={fuelOpen}
      onClose={() => setFuelOpen(false)}
      truckPlate={user?.assigned_truck?.plate ?? null}
      truckLabel={user?.assigned_truck ? `${user.assigned_truck.plate} · ${user.assigned_truck.type}` : null}
    />
    </>
  );
}

function AssignmentCard({
  trip,
  onPress,
  isNext,
}: {
  trip: Trip;
  onPress: () => void;
  isNext?: boolean;
}) {
  const { t } = useTranslation();
  const holidays = useHolidaySet();
  // The real incentive_earned is only set on completion (null/0 while the trip is
  // assigned or in progress). Until then show an estimate, marked "Est.", matching
  // TripDetailsScreen — never a bare RM 0 on an active assignment.
  const finalized = trip.incentive_earned !== null && trip.incentive_earned !== undefined;
  const estimate = finalized ? null : estimateIncentive(trip, holidays);
  // No estimate computable → "—", never a green "RM 0" on an active
  // assignment (audit 2026-07-05 #5 — TripCard's rule).
  const rmValue = finalized
    ? formatMoney(trip.incentive_earned)
    : estimate !== null
      ? formatMoney(estimate)
      : "—";
  const showEst = !finalized && estimate !== null;
  return (
    <View style={[styles.assignCard, isNext && styles.assignCardNext]}>
      <View style={styles.assignHead}>
        <StatusBadge status={trip.status} small />
        {isNext ? (
          <View style={styles.nextTag}>
            <Text style={styles.nextTagText}>{t("driver.next")}</Text>
          </View>
        ) : null}
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
          <View style={styles.assignRmWrap}>
            {showEst ? <Text style={styles.assignEst}>{t("trip.est")}</Text> : null}
            <Text style={styles.assignRm}>{rmValue}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.detailBtn} onPress={onPress}>
          <Text style={styles.detailBtnText}>{t("driver.viewTripDetails")}</Text>
          <Ionicons name="arrow-forward" size={14} color={colors.white} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  // Desktop: cap + centre the mobile column instead of stretching edge-to-edge.
  centerCol: { width: "100%", maxWidth: layout.content, alignSelf: "center" },
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
  date: { color: "rgba(255,255,255,0.65)", fontSize: 13, marginTop: 12 },
  // Same greeting scale as the requestor home (owner-approved balance).
  greeting: { color: colors.white, fontSize: 26, fontWeight: "800", marginTop: 4 },
  sub: { color: "rgba(255,255,255,0.85)", fontSize: 15, fontWeight: "600", marginTop: 3 },
  section: { paddingHorizontal: 16, paddingTop: 16, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },
  countPill: { backgroundColor: colors.yellow, paddingHorizontal: 10, paddingVertical: 2, borderRadius: radius.pill },
  countText: { color: colors.navy, fontSize: 13, fontWeight: "800" },
  upcomingLabel: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 16, marginBottom: -4 },

  activeCard: { backgroundColor: colors.blueDark, borderRadius: radius.xl, padding: 18, ...shadow.card },
  activeTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 },
  activeLabel: { fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.5)", letterSpacing: 1, textTransform: "uppercase" },
  activeTicket: { fontSize: 18, fontWeight: "800", color: colors.white, marginTop: 2 },
  onRoute: { backgroundColor: colors.yellow, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  onRouteText: { color: colors.blue, fontSize: 12, fontWeight: "800" },
  routeMini: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  miniDot: { width: 8, height: 8, borderRadius: 4 },
  miniPlace: { fontSize: 14, fontWeight: "600", color: colors.white },
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
  assignCardNext: { borderWidth: 2, borderColor: colors.yellow },
  assignHead: { backgroundColor: colors.blue, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  nextTag: { backgroundColor: colors.yellow, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  nextTagText: { color: colors.navy, fontSize: 12, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  assignPlate: { backgroundColor: "rgba(255,255,255,0.15)", color: colors.white, fontSize: 12, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  assignType: { marginLeft: "auto", color: colors.yellow, fontSize: 12, fontWeight: "700" },
  assignBody: { padding: 14 },
  assignTime: { fontSize: 13, fontWeight: "700", color: colors.orange },
  assignPlace: { fontSize: 14, fontWeight: "600", color: colors.navy },
  assignPlaceTo: { fontSize: 14, fontWeight: "600", color: colors.navy, marginTop: 6 },
  assignFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  assignCargo: { fontSize: 13, color: colors.textMuted },
  assignRmWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  assignEst: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 },
  assignRm: { backgroundColor: colors.yellow, color: colors.navy, fontSize: 14, fontWeight: "800", paddingHorizontal: 14, paddingVertical: 4, borderRadius: radius.pill, overflow: "hidden" },
  detailBtn: {
    marginTop: 12,
    height: 48, // glove-friendly touch floor
    backgroundColor: colors.blue,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  detailBtnText: { color: colors.white, fontSize: 14, fontWeight: "700" },

  emptyRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  emptyText: { fontSize: 14, color: colors.textMuted },

  fuelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: 12,
    paddingHorizontal: 14,
    ...shadow.card,
  },
  fuelIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  fuelTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },
  fuelSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
