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
import { actionShadow, colors, layout, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { StatusBadge } from "../../components/StatusBadge";
import { LoadingState, ErrorState } from "../../components/States";
import { dayMonth, formatDate } from "../../lib/format";
import { tripConsigneeName, tripDestination, totalPallets, ORIGIN_LABEL } from "../../lib/trip";
import { ACTIVE_STATUSES, DELIVERED_STATUSES } from "../../lib/tripStatus";
import { Trip } from "../../types";
import { formatPalletSpaces } from "../../lib/pallets";

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

  const activeCount = useMemo(
    () => (trips ?? []).filter((tr) => ACTIVE_STATUSES.includes(tr.status)).length,
    [trips]
  );

  const openTrip = (id: string) => navigation.navigate("BookingDetail", { tripId: id });

  // The empty state has to answer the tab that produced it: "no bookings yet"
  // is wrong when the requestor has twenty completed ones and simply filtered
  // to Active.
  //
  // ⚠ THE EMPTY STATE'S OWN CTA AND THE FLOATING BUTTON ARE THE SAME ACTION.
  // Showing both put two "New Booking" affordances on one otherwise-empty
  // screen, and the navy button already carries it. The rule this screen now
  // follows is NEVER TWO, NEVER ZERO: the FAB stands down exactly when the
  // empty state is offering the button itself, and comes back everywhere else —
  // including the empty COMPLETED tab, where the empty state deliberately
  // offers nothing (a requestor with active bookings and no completed ones
  // would otherwise be left with no way to book from this screen at all).
  const emptyOffersItsOwnCta = filtered.length === 0 && filter !== "completed";
  const emptyState = (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name="clipboard-outline" size={30} color={colors.blue} />
      </View>
      <Text style={styles.emptyTitle}>
        {t(filter === "all" ? "history.emptyTitle" : `history.emptyTitle_${filter}`)}
      </Text>
      <Text style={styles.emptyBody}>
        {t(filter === "all" ? "history.emptyBody" : `history.emptyBody_${filter}`)}
      </Text>
      {filter !== "completed" ? (
        <TouchableOpacity
          style={styles.emptyBtn}
          onPress={() => navigation.navigate("NewBooking")}
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={18} color={colors.white} />
          <Text style={styles.emptyBtnText}>{t("tabs.newBooking")}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <View style={styles.fill}>
      <Header
        title={t("tabs.bookings")}
        right={
          // The count that means something is how many are still IN FLIGHT —
          // "37 trips" is a lifetime total nobody acts on. On a PC the "+" stays
          // in the header; on a phone it is the floating button below, which is
          // reachable one-handed.
          activeCount > 0 ? (
            <View style={styles.countPill}>
              <Text style={styles.countText}>{t("history.activeCount", { count: activeCount })}</Text>
            </View>
          ) : wide ? (
            <TouchableOpacity
              onPress={() => navigation.navigate("NewBooking")}
              accessibilityLabel={t("tabs.newBooking")}
              hitSlop={8}
              style={styles.headerAdd}
            >
              <Ionicons name="add" size={24} color={colors.white} />
            </TouchableOpacity>
          ) : null
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
          ListEmptyComponent={emptyState}
          renderItem={({ item, index }) => (
            <TableRow trip={item} last={index === filtered.length - 1} onPress={() => openTrip(item.id)} />
          )}
        />
      ) : (
        <>
          <FlatList
            data={filtered}
            keyExtractor={(tr) => tr.id}
            contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: 96, flexGrow: 1, width: "100%", maxWidth: layout.content, alignSelf: "center" }}
            refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
            ListEmptyComponent={emptyState}
            renderItem={({ item }) => (
              <BookingRow trip={item} onPress={() => openTrip(item.id)} />
            )}
          />
          {/* New Booking is not a tab; this and the Home hero CTA are the two
              ways in. Floating over the list so it survives scrolling — and
              suppressed while the empty state is offering the same action (see
              `emptyOffersItsOwnCta` above). */}
          {emptyOffersItsOwnCta ? null : (
            <TouchableOpacity
              style={styles.fab}
              onPress={() => navigation.navigate("NewBooking")}
              accessibilityLabel={t("tabs.newBooking")}
              activeOpacity={0.85}
            >
              <Ionicons name="add" size={26} color={colors.navy} />
            </TouchableOpacity>
          )}
        </>
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

// ── Narrow card (phone) — design frame 8 ───────────────────────────────────
function BookingRow({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const { t } = useTranslation();
  const dm = dayMonth(trip.pickup_datetime);
  // A finished booking's date block goes grey. The blue block is a "this is
  // still live" signal, and every card wearing it made the list read as though
  // nothing had ever completed.
  const live = ACTIVE_STATUSES.includes(trip.status);
  const stops = trip.stops?.length ?? 0;
  const pallets = totalPallets(trip);
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={styles.card}>
      <View style={[styles.dateBlock, !live && styles.dateBlockPast]}>
        <Text style={[styles.dateDay, !live && styles.dateDayPast]}>{dm.day}</Text>
        <Text style={[styles.dateMon, !live && styles.dateMonPast]}>{dm.mon}</Text>
      </View>
      <View style={styles.cardBody}>
        {/* The consignee, not "UWC → area": the requestor knows where it left
            from — what they scan for is who it is going to. */}
        <Text style={styles.route} numberOfLines={1}>
          {tripConsigneeName(trip)}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {[
            trip.ticket_number,
            stops > 0 ? t("history.stopCount", { count: stops }) : null,
            pallets > 0 ? t("history.palletCount", { count: pallets, spaces: formatPalletSpaces(pallets) }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <View style={styles.cardBadge}>
          <StatusBadge status={trip.status} small />
        </View>
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

  headerAdd: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },

  // Narrow card (design frame 8)
  card: { flexDirection: "row", backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, overflow: "hidden", marginBottom: 10, ...shadow.card },
  dateBlock: { width: 64, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingVertical: 16, gap: 2 },
  dateBlockPast: { backgroundColor: "#eceff6" },
  dateDay: { color: colors.white, fontSize: 20, fontWeight: "900" },
  dateDayPast: { color: colors.navy },
  dateMon: { color: colors.yellow, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  dateMonPast: { color: colors.textMuted },
  cardBody: { flex: 1, paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  route: { fontSize: 15, fontWeight: "800", color: colors.navy },
  meta: { fontSize: 13, color: colors.textMuted },
  cardBadge: { alignSelf: "flex-start" },

  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
    ...actionShadow.yellow,
  },

  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingVertical: 40, gap: 14 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 17, fontWeight: "800", color: colors.navy, textAlign: "center" },
  emptyBody: { fontSize: 14, color: colors.textMuted, lineHeight: 20, textAlign: "center", maxWidth: 280 },
  emptyBtn: { minHeight: 48, paddingHorizontal: 22, borderRadius: radius.md, backgroundColor: colors.blue, flexDirection: "row", alignItems: "center", gap: 8 },
  emptyBtnText: { fontSize: 15, fontWeight: "800", color: colors.white },
});
