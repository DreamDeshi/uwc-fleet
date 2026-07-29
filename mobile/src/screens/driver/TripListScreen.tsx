import React, { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { TripsStackParamList } from "../../navigation/types";
import { useTrips } from "../../hooks/queries";
import { colors, layout, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { TripCard } from "../../components/TripCard";
import { LoadingState, ErrorState, EmptyState } from "../../components/States";
import { totalPallets } from "../../lib/trip";
import { formatTime } from "../../lib/format";
import { currentStopNumber, stopsOf } from "../../lib/driverHome";
import { ACTIVE_STATUSES, DELIVERED_STATUSES } from "../../lib/tripStatus";

type Nav = NativeStackNavigationProp<TripsStackParamList, "TripList">;
type Filter = "all" | "active" | "completed";

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
    // DELIVERED_STATUSES, not `=== "completed"`: a trip awaiting POD approval is
    // driven and delivered — it belongs here, not in no tab at all.
    if (filter === "completed") return list.filter((tr) => DELIVERED_STATUSES.includes(tr.status));
    return list;
  }, [trips, filter]);

  return (
    <View style={styles.fill}>
      <Header
        title={t("driver.myTrips")}
        right={
          <View style={styles.countPill}>
            <Text style={styles.countText}>{t("history.tripsCount", { count: filtered.length })}</Text>
          </View>
        }
      />

      {/* Filter tabs */}
      <View style={styles.centerCol}>
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
      </View>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(tr) => tr.id}
          contentContainerStyle={{ padding: 16, paddingTop: 4, flexGrow: 1, width: "100%", maxWidth: layout.content, alignSelf: "center" }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
          ListEmptyComponent={<EmptyState message={t("history.empty")} icon="cube-outline" />}
          renderItem={({ item }) => {
            const stops = stopsOf(item);
            // The record of work, in the driver's terms: ticket, when it leaves
            // (only while it still hasn't), how many drops, how much cargo. No
            // money — that lives on My Stats (approved design, 29 Jul 2026).
            const meta = [
              item.ticket_number,
              item.status === "assigned" ? formatTime(item.pickup_datetime) : null,
              t("driver.stopCount", { n: stops.length }),
              t("driver.palletCount", { n: totalPallets(item) }),
            ]
              .filter(Boolean)
              .join(" · ");
            const live = item.status === "in_progress";
            return (
              <TripCard
                trip={item}
                meta={meta}
                onPress={() => navigation.navigate("TripDetails", { tripId: item.id })}
                continueLabel={
                  live
                    ? t("driver.continueAtStop", {
                        n: currentStopNumber(item),
                        total: stops.length,
                      })
                    : undefined
                }
                onContinue={live ? () => navigation.navigate("ActiveTrip", { tripId: item.id }) : undefined}
              />
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  centerCol: { width: "100%", maxWidth: layout.content, alignSelf: "center" },
  countPill: { backgroundColor: colors.yellow, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  countText: { color: colors.navy, fontSize: 13, fontWeight: "800" },
  tabs: { flexDirection: "row", gap: 4, backgroundColor: colors.white, margin: 16, marginBottom: 8, borderRadius: radius.md, padding: 4, ...shadow.card },
  // 44, not 36 — these are the driver's most-tapped controls and the design
  // holds every target at the 44px floor.
  tab: { flex: 1, height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  tabActive: { backgroundColor: colors.blue },
  tabText: { fontSize: 13, fontWeight: "700", color: colors.textMuted },
  tabTextActive: { color: colors.white },
});
