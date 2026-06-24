import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { DriverTabParamList } from "../../navigation/types";
import { useIncentives } from "../../hooks/queries";
import { colors, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { Card } from "../../components/Card";
import { LoadingState, ErrorState, EmptyState } from "../../components/States";
import { formatMoney, formatDate, monthYear } from "../../lib/format";

export function EarningsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<BottomTabNavigationProp<DriverTabParamList>>();
  const { data, isLoading, isError, refetch, isRefetching } = useIncentives();

  const openTrip = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "TripDetails", params: { tripId } });

  return (
    <View style={styles.fill}>
      <Header title={t("earnings.title")} />
      {isLoading ? (
        <LoadingState />
      ) : isError || !data ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        >
          {/* Gradient-style summary card */}
          <View style={styles.summaryCard}>
            <Text style={styles.summaryMonth}>{monthYear(data.summary.month)}</Text>
            <Text style={styles.summaryAmount}>{formatMoney(data.summary.total)}</Text>
            <Text style={styles.summaryMeta}>
              {t("earnings.tripsCount", { count: data.summary.trip_count })}
            </Text>
          </View>

          {/* Breakdown */}
          <Text style={styles.breakdownTitle}>{t("earnings.breakdown")}</Text>
          {data.trips.length === 0 ? (
            <EmptyState message={t("earnings.noEarnings")} icon="cash-outline" />
          ) : (
            <Card padded={false} style={{ overflow: "hidden" }}>
              {data.trips.map((tr, i) => (
                <TouchableOpacity
                  key={tr.id}
                  activeOpacity={0.7}
                  onPress={() => openTrip(tr.id)}
                  style={[styles.row, i < data.trips.length - 1 && styles.divider]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowRoute}>{tr.destination ?? tr.ticket_number}</Text>
                    <Text style={styles.rowMeta}>
                      {formatDate(tr.pickup_datetime)} · {tr.route_type ?? ""} · {tr.truck_plate ?? ""}
                    </Text>
                  </View>
                  <Text style={styles.rowRm}>{formatMoney(tr.incentive_earned)}</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={{ marginLeft: 8 }} />
                </TouchableOpacity>
              ))}
            </Card>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  summaryCard: { backgroundColor: colors.blue, borderRadius: radius.xl, padding: 22, ...shadow.card },
  summaryMonth: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", marginBottom: 4 },
  summaryAmount: { color: colors.white, fontSize: 42, fontWeight: "900", letterSpacing: -1 },
  summaryMeta: { color: "rgba(255,255,255,0.8)", fontSize: 13, marginTop: 4 },
  breakdownTitle: { fontSize: 15, fontWeight: "700", color: colors.navy, marginTop: 20, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  rowRoute: { fontSize: 14, fontWeight: "700", color: colors.navy },
  rowMeta: { fontSize: 11, color: colors.textFaint, marginTop: 3 },
  rowRm: { fontSize: 15, fontWeight: "800", color: colors.green },
});
