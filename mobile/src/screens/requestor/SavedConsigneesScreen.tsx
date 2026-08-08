import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RequestorStackParamList } from "../../navigation/types";
import { colors, layout, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { LoadingState, ErrorState } from "../../components/States";
import { NewConsigneeModal } from "../../components/NewConsigneeModal";
import { useConsignees, useTrips, CONSIGNEE_SEARCH_MIN } from "../../hooks/queries";
import type { Consignee } from "../../types";

/**
 * The companies this requestor has actually delivered to (design frame 12's
 * "Saved Consignees"), with the full directory behind a search box.
 *
 * WHAT "SAVED" MEANS HERE: consignees are a SHARED, admin-curated directory —
 * there is no per-requestor saved list in the schema, and inventing one would
 * be a data model the office does not have. So the default view is derived:
 * every company on this requestor's own bookings, most recent first. That is
 * the list the frame's row is actually useful for, and it needs no API change.
 * Typing searches the whole directory, exactly as the booking form does.
 */
export function SavedConsigneesScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RequestorStackParamList>>();
  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();
  const [search, setSearch] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const { data: results = [], isFetching } = useConsignees(search);

  const query = search.trim();
  const searching = query.length >= CONSIGNEE_SEARCH_MIN;

  // Deduplicated by consignee id, newest booking first, with how many times it
  // has been used — the one fact that makes the list scannable.
  const mine = useMemo(() => {
    const seen = new Map<string, { consignee: Consignee; count: number }>();
    const sorted = (trips ?? [])
      .slice()
      .sort((a, b) => +new Date(b.pickup_datetime) - +new Date(a.pickup_datetime));
    for (const tr of sorted) {
      for (const s of tr.stops ?? []) {
        if (!s.consignee) continue;
        const hit = seen.get(s.consignee.id);
        if (hit) hit.count += 1;
        else seen.set(s.consignee.id, { consignee: s.consignee, count: 1 });
      }
    }
    return [...seen.values()];
  }, [trips]);

  const rows = searching
    ? results.map((c) => ({ consignee: c, count: 0 }))
    : mine;

  const subtitle = (c: Consignee) =>
    [c.zone?.name ? `${c.zone_code} — ${c.zone.name}` : c.zone_code, c.area, c.state]
      .filter(Boolean)
      .join(" · ");

  return (
    <View style={styles.fill}>
      <Header title={t("account.savedConsignees")} onBack={() => navigation.goBack()} />

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.textFaint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t("booking.searchConsignee")}
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
          />
          {isFetching ? (
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.textFaint} />
          ) : query.length > 0 ? (
            <TouchableOpacity onPress={() => setSearch("")} hitSlop={10} accessibilityLabel={t("common.clear")}>
              <Ionicons name="close-circle" size={20} color={colors.textFaint} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.sectionLabel}>
            {searching ? t("account.searchResults") : t("account.yourCompanies")}
          </Text>

          {rows.length === 0 ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="business-outline" size={30} color={colors.blue} />
              </View>
              <Text style={styles.emptyTitle}>
                {searching ? t("account.noCompaniesFound") : t("account.noCompaniesYet")}
              </Text>
              <Text style={styles.emptyBody}>
                {searching ? t("booking.noMatchBody") : t("account.noCompaniesYetBody")}
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              {rows.map(({ consignee, count }, i) => (
                <View key={consignee.id} style={[styles.row, i < rows.length - 1 && styles.divider]}>
                  <View style={styles.rowIcon}>
                    <Ionicons name="business-outline" size={18} color={colors.blue} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.rowTitle} numberOfLines={2}>
                      {consignee.company_name}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {subtitle(consignee)}
                    </Text>
                  </View>
                  {count > 0 ? (
                    <View style={styles.countPill}>
                      <Text style={styles.countText}>{t("account.tripCount", { count })}</Text>
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity style={styles.addBtn} onPress={() => setNewOpen(true)} activeOpacity={0.85}>
            <Ionicons name="add" size={18} color={colors.blue} />
            <Text style={styles.addBtnText}>{t("booking.addManually")}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      <NewConsigneeModal
        visible={newOpen}
        initialName={searching && results.length === 0 ? query : undefined}
        onClose={() => setNewOpen(false)}
        // Adding from here is directory maintenance, not booking — the new
        // company simply lands in the list the next search finds.
        onCreated={() => setSearch("")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { paddingHorizontal: 16, paddingTop: 14, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 14, minHeight: 50 },
  searchInput: { flex: 1, fontSize: 15, color: colors.navy, paddingVertical: 12 },
  body: { padding: 16, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  sectionLabel: { fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", color: colors.textFaint, marginBottom: 8 },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, ...shadow.card },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  rowIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  rowTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },
  rowMeta: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  countPill: { flexShrink: 0, backgroundColor: colors.tintBlue, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  countText: { fontSize: 12, fontWeight: "800", color: colors.blue },
  empty: { alignItems: "center", gap: 12, paddingVertical: 36, paddingHorizontal: 24 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 17, fontWeight: "800", color: colors.navy, textAlign: "center" },
  emptyBody: { fontSize: 14, color: colors.textMuted, lineHeight: 20, textAlign: "center", maxWidth: 300 },
  addBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, marginTop: 16, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.white },
  addBtnText: { fontSize: 15, fontWeight: "700", color: colors.blue },
});
