import React, { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { TripsStackParamList } from "../../navigation/types";
import { useTrips } from "../../hooks/queries";
import { colors, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { StatusBadge } from "../../components/StatusBadge";
import { LoadingState, ErrorState, EmptyState } from "../../components/States";
import { formatMoney, dayMonth } from "../../lib/format";
import { tripDestination, cargoSummary, ORIGIN_LABEL } from "../../lib/trip";
import { Trip, TripStatus } from "../../types";

type Nav = NativeStackNavigationProp<TripsStackParamList, "TripList">;
type Filter = "all" | "active" | "completed";

const ACTIVE_STATUSES: TripStatus[] = ["assigned", "in_progress", "approved", "pending"];

export function TripListScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const list = (trips ?? []).slice().sort(
      (a, b) => +new Date(b.pickup_datetime) - +new Date(a.pickup_datetime)
    );
    if (filter === "active") return list.filter((tr) => ACTIVE_STATUSES.includes(tr.status));
    if (filter === "completed") return list.filter((tr) => tr.status === "completed");
    return list;
  }, [trips, filter]);

  return (
    <View style={styles.fill}>
      <Header
        title={t("history.title")}
        right={
          <View style={styles.countPill}>
            <Text style={styles.countText}>{t("history.tripsCount", { count: trips?.length ?? 0 })}</Text>
          </View>
        }
      />

      {/* Filter tabs */}
      <View style={styles.tabs}>
        {(["all", "active", "completed"] as const).map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.tab, filter === f && styles.tabActive]}
            onPress={() => setFilter(f)}
          >
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
            <TripRow trip={item} onPress={() => navigation.navigate("TripDetails", { tripId: item.id })} />
          )}
        />
      )}
    </View>
  );
}

function TripRow({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const dm = dayMonth(trip.pickup_datetime);
  const dim = trip.status === "cancelled" || trip.status === "rejected";
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[styles.card, dim && { opacity: 0.7 }]}>
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
          {trip.ticket_number} · {cargoSummary(trip)}
        </Text>
        <Text style={[styles.rm, dim && { color: colors.textFaint }]}>
          {formatMoney(trip.incentive_earned)}
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
  cardBody: { flex: 1, padding: 12 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  route: { flex: 1, fontSize: 13, fontWeight: "700", color: colors.navy },
  meta: { fontSize: 11, color: colors.textFaint, marginTop: 4 },
  rm: { fontSize: 15, fontWeight: "800", color: colors.green, marginTop: 8 },
});
