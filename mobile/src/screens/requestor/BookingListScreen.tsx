import React, { useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, type RouteProp, type CompositeNavigationProp } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RequestorStackParamList, RequestorTabParamList } from "../../navigation/types";
import { useTrips } from "../../hooks/queries";
import { useWide } from "../../hooks/useWide";
import { colors, layout, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { StatusBadge } from "../../components/StatusBadge";
import { LoadingState, ErrorState, EmptyState } from "../../components/States";
import { dayMonth, formatDate } from "../../lib/format";
import { tripDestination, ORIGIN_LABEL } from "../../lib/trip";
import { ACTIVE_STATUSES, DELIVERED_STATUSES } from "../../lib/tripStatus";
import { Trip } from "../../types";

// Tab screen, but it can also push BookingDetail onto the parent requestor stack.
type Nav = CompositeNavigationProp<
  BottomTabNavigationProp<RequestorTabParamList, "BookingsTab">,
  NativeStackNavigationProp<RequestorStackParamList>
>;
type Rt = RouteProp<RequestorTabParamList, "BookingsTab">;
type Filter = "all" | "active" | "completed";

export function BookingListScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const wide = useWide();
  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();
  const [filter, setFilter] = useState<Filter>(route.params?.filter ?? "all");

  // Honour deep links from the dashboard stat cards (e.g. tapping "Completed").
  useEffect(() => {
    if (route.params?.filter) setFilter(route.params.filter);
  }, [route.params?.filter]);

  const filtered = useMemo(() => {
    const list = (trips ?? []).slice().sort(
      (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
    );
    if (filter === "active") return list.filter((tr) => ACTIVE_STATUSES.includes(tr.status));
    // DELIVERED_STATUSES, not `=== "completed"`: a booking awaiting POD approval
    // has still been delivered, and belongs here rather than in no tab at all.
    if (filter === "completed") return list.filter((tr) => DELIVERED_STATUSES.includes(tr.status));
    return list;
  }, [trips, filter]);

  const openTrip = (id: string) => navigation.navigate("BookingDetail", { tripId: id });

  return (
    <View style={styles.fill}>
      <Header
        title={t("tabs.bookings")}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={styles.countPill}>
              <Text style={styles.countText}>{t("history.tripsCount", { count: trips?.length ?? 0 })}</Text>
            </View>
            {/* New Booking moved off the tab bar — this "+" and the Home hero CTA
                are the two entry points into the booking form. */}
            <TouchableOpacity
              onPress={() => navigation.navigate("NewBooking")}
              accessibilityLabel={t("tabs.newBooking")}
              hitSlop={8}
              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="add" size={24} color={colors.white} />
            </TouchableOpacity>
          </View>
        }
      />
      <View style={wide ? styles.fillCol : styles.centerCol}>
        <View style={[styles.tabs, wide && styles.tabsWide]}>
          {(["all", "active", "completed"] as const).map((f) => (
            <TouchableOpacity key={f} style={[styles.tab, filter === f && styles.tabActive]} onPress={() => setFilter(f)}>
              <Text style={[styles.tabText, filter === f && styles.tabTextActive]}>
                {f === "all" ? t("history.all") : f === "active" ? t("history.active") : t("history.completed")}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={refetch} />
      ) : wide ? (
        // ── Wide (PC) — a proper data table (there's room; the phone keeps cards) ──
        <FlatList
          data={filtered}
          keyExtractor={(tr) => tr.id}
          style={{ width: "100%" }}
          contentContainerStyle={styles.tableWrap}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
          ListHeaderComponent={filtered.length > 0 ? <TableHeader t={t} /> : null}
          ListEmptyComponent={<EmptyState message={t("history.empty")} icon="cube-outline" />}
          renderItem={({ item, index }) => (
            <TableRow trip={item} last={index === filtered.length - 1} onPress={() => openTrip(item.id)} />
          )}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(tr) => tr.id}
          contentContainerStyle={{ padding: 16, paddingTop: 4, flexGrow: 1, width: "100%", maxWidth: layout.content, alignSelf: "center" }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
          ListEmptyComponent={<EmptyState message={t("history.empty")} icon="cube-outline" />}
          renderItem={({ item }) => (
            <BookingRow trip={item} onPress={() => openTrip(item.id)} />
          )}
        />
      )}
    </View>
  );
}

// ── Wide table ────────────────────────────────────────────────────────────
function TableHeader({ t }: { t: (k: string) => string }) {
  return (
    <View style={styles.tableHeader}>
      <Text style={[styles.thCell, { flex: 1 }]}>{t("history.colDate")}</Text>
      <Text style={[styles.thCell, { flex: 1.1 }]}>{t("history.colTicket")}</Text>
      <Text style={[styles.thCell, { flex: 2.4 }]}>{t("history.colRoute")}</Text>
      <Text style={[styles.thCell, { flex: 1.4 }]}>{t("history.colType")}</Text>
      <Text style={[styles.thCell, { flex: 1, textAlign: "right" }]}>{t("history.colStatus")}</Text>
    </View>
  );
}

function TableRow({ trip, last, onPress }: { trip: Trip; last: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={[styles.tableRow, last && styles.tableRowLast]}>
      <Text style={[styles.tdCell, { flex: 1, color: colors.textMuted }]}>{formatDate(trip.pickup_datetime)}</Text>
      <Text style={[styles.tdCell, { flex: 1.1, fontWeight: "700", color: colors.blue }]} numberOfLines={1}>
        {trip.ticket_number}
      </Text>
      <Text style={[styles.tdCell, { flex: 2.4, fontWeight: "600" }]} numberOfLines={1}>
        {ORIGIN_LABEL} → {tripDestination(trip)}
      </Text>
      <Text style={[styles.tdCell, { flex: 1.4, color: colors.textMuted }]} numberOfLines={1}>
        {trip.route_type?.name ?? "—"}
      </Text>
      <View style={{ flex: 1, alignItems: "flex-end" }}>
        <StatusBadge status={trip.status} small />
      </View>
    </TouchableOpacity>
  );
}

// ── Narrow card (phone) — unchanged ─────────────────────────────────────────
function BookingRow({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const dm = dayMonth(trip.pickup_datetime);
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={styles.card}>
      <View style={styles.dateBlock}>
        <Text style={styles.dateDay}>{dm.day}</Text>
        <Text style={styles.dateMon}>{dm.mon}</Text>
      </View>
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={styles.route} numberOfLines={1}>
            {ORIGIN_LABEL} → {tripDestination(trip)}
          </Text>
          <StatusBadge status={trip.status} small />
        </View>
        <Text style={styles.meta}>
          {trip.ticket_number} · {trip.route_type?.name ?? ""}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  centerCol: { width: "100%", maxWidth: layout.content, alignSelf: "center" },
  fillCol: { width: "100%" },
  countPill: { backgroundColor: colors.yellow, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  countText: { color: colors.navy, fontSize: 13, fontWeight: "800" },
  tabs: { flexDirection: "row", backgroundColor: colors.white, margin: 16, marginBottom: 8, borderRadius: radius.md, padding: 4, ...shadow.card },
  // On a PC the segmented control shouldn't stretch — pin it left.
  tabsWide: { alignSelf: "flex-start", width: 420, marginHorizontal: 28, marginTop: 20 },
  tab: { flex: 1, height: 36, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  tabActive: { backgroundColor: colors.blue },
  tabText: { fontSize: 13, fontWeight: "700", color: colors.textMuted },
  tabTextActive: { color: colors.white },

  // Wide table — fills the content area beside the sidebar.
  tableWrap: {
    width: "100%",
    marginTop: 4,
    marginBottom: 24,
    paddingHorizontal: 28,
    flexGrow: 1,
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.tintBlue,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  thCell: { fontSize: 12, fontWeight: "800", color: colors.blue, textTransform: "uppercase", letterSpacing: 0.5 },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.white,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderLight,
    borderBottomColor: colors.bg,
    paddingHorizontal: 18,
    paddingVertical: 15,
    gap: 8,
  },
  tableRowLast: {
    borderBottomColor: colors.borderLight,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
  },
  tdCell: { fontSize: 14, color: colors.navy },

  // Narrow card
  card: { flexDirection: "row", backgroundColor: colors.white, borderRadius: radius.lg, overflow: "hidden", marginBottom: 10, ...shadow.card },
  dateBlock: { width: 56, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingVertical: 16 },
  dateDay: { color: colors.white, fontSize: 22, fontWeight: "800" },
  dateMon: { color: colors.yellow, fontSize: 12, fontWeight: "700", letterSpacing: 0.6 },
  cardBody: { flex: 1, padding: 12, justifyContent: "center" },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  route: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.navy },
  meta: { fontSize: 12, color: colors.textFaint, marginTop: 4 },
});
