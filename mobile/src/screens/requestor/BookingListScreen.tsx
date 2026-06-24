import React, { useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, type RouteProp, type CompositeNavigationProp } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RequestorStackParamList, RequestorTabParamList } from "../../navigation/types";
import { useTrips } from "../../hooks/queries";
import { colors, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { StatusBadge } from "../../components/StatusBadge";
import { LoadingState, ErrorState, EmptyState } from "../../components/States";
import { dayMonth } from "../../lib/format";
import { tripDestination, ORIGIN_LABEL } from "../../lib/trip";
import { Trip, TripStatus } from "../../types";

// Tab screen, but it can also push BookingDetail onto the parent requestor stack.
type Nav = CompositeNavigationProp<
  BottomTabNavigationProp<RequestorTabParamList, "BookingsTab">,
  NativeStackNavigationProp<RequestorStackParamList>
>;
type Rt = RouteProp<RequestorTabParamList, "BookingsTab">;
type Filter = "all" | "active" | "completed";

const ACTIVE: TripStatus[] = ["pending", "approved", "assigned", "in_progress"];

export function BookingListScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
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
    if (filter === "active") return list.filter((tr) => ACTIVE.includes(tr.status));
    if (filter === "completed") return list.filter((tr) => tr.status === "completed");
    return list;
  }, [trips, filter]);

  return (
    <View style={styles.fill}>
      <Header
        title={t("tabs.bookings")}
        right={
          <View style={styles.countPill}>
            <Text style={styles.countText}>{t("history.tripsCount", { count: trips?.length ?? 0 })}</Text>
          </View>
        }
      />
      <View style={styles.tabs}>
        {(["all", "active", "completed"] as const).map((f) => (
          <TouchableOpacity key={f} style={[styles.tab, filter === f && styles.tabActive]} onPress={() => setFilter(f)}>
            <Text style={[styles.tabText, filter === f && styles.tabTextActive]}>
              {f === "all" ? t("history.all") : f === "active" ? t("history.active") : t("history.completed")}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(tr) => tr.id}
          contentContainerStyle={{ padding: 16, paddingTop: 4, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
          ListEmptyComponent={<EmptyState message={t("history.empty")} icon="cube-outline" />}
          renderItem={({ item }) => (
            <BookingRow trip={item} onPress={() => navigation.navigate("BookingDetail", { tripId: item.id })} />
          )}
        />
      )}
    </View>
  );
}

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
  countPill: { backgroundColor: colors.yellow, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  countText: { color: colors.navy, fontSize: 12, fontWeight: "800" },
  tabs: { flexDirection: "row", backgroundColor: colors.white, margin: 16, marginBottom: 8, borderRadius: radius.md, padding: 4, ...shadow.card },
  tab: { flex: 1, height: 36, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  tabActive: { backgroundColor: colors.blue },
  tabText: { fontSize: 12, fontWeight: "700", color: colors.textMuted },
  tabTextActive: { color: colors.white },
  card: { flexDirection: "row", backgroundColor: colors.white, borderRadius: radius.lg, overflow: "hidden", marginBottom: 10, ...shadow.card },
  dateBlock: { width: 56, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingVertical: 16 },
  dateDay: { color: colors.white, fontSize: 22, fontWeight: "800" },
  dateMon: { color: colors.yellow, fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  cardBody: { flex: 1, padding: 12, justifyContent: "center" },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  route: { flex: 1, fontSize: 13, fontWeight: "700", color: colors.navy },
  meta: { fontSize: 11, color: colors.textFaint, marginTop: 4 },
});
