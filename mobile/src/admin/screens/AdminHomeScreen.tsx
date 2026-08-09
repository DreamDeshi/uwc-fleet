// Admin landing — split by layout (owner direction, 13 Jul 2026):
//   NARROW (phone): HOME — the greeting home and the dashboard MERGED into
//   the one landing screen of the bottom-tab shell (mobile polish pass,
//   14 Jul 2026): greeting header, approval-queue action card, today's
//   stats, the attention panel (deep-links to the Trips tab) and the
//   Phase-3 fleet map. The old "Manage" list moved to the MORE tab; the
//   hamburger is gone (bottom bar replaced the drawer).
//   WIDE (PC): the old web admin's dashboard layout instead — dispatch
//   bar, attention panel, gradient KPI tiles, map + rail, recent trips
//   (DashboardWide.tsx). Untouched by the mobile pass.
// Data comes from the already-ported hooks — read-only, no new logic.
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import { useAuth } from "../../context/AuthContext";
import { useAttention, useDashboard, useFleetLive, usePendingApprovals, usePendingUsers, useTrucks } from "../hooks/queries";
import { colors, font, radius, shadow } from "../theme";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { AttentionPanel, attentionHasRows } from "../components/AttentionPanel";
import { AdminSearchButton } from "../components/AdminSearchButton";
import { exceptionsEnabled, changeRequestsEnabled } from "../../lib/featureFlags";
import { AdminFleetMap } from "../platform/map";
import { formatDate } from "../../lib/format";
import { homeAttention } from "../lib/adminHome";
import { greetingFontSize, greetingName } from "../../lib/greetingName";
import { DashboardWide } from "./DashboardWide";

type IoniconName = keyof typeof Ionicons.glyphMap;

export function AdminHomeScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const { user } = useAuth();
  const mode = useLayoutMode();
  const dashboard = useDashboard();
  const pending = usePendingUsers();
  const pendingApprovals = usePendingApprovals();
  const attention = useAttention();
  const trucks = useTrucks();
  const live = useFleetLive();

  const pendingCount = pending.data?.length ?? 0;
  const approvalCount = pendingApprovals.data?.length ?? 0;
  const k = dashboard.data;
  const liveCount = (live.data ?? []).filter((p) => !p.stale).length;
  const strip = homeAttention(k);
  const refreshing = dashboard.isRefetching || pending.isRefetching || attention.isRefetching;
  const refetchAll = () => {
    dashboard.refetch();
    pending.refetch();
    pendingApprovals.refetch();
    attention.refetch();
    trucks.refetch();
    live.refetch();
  };

  // PC gets the real dashboard; the merged home below is mobile-only.
  if (mode === "wide") return <DashboardWide />;

  // Promoted MORE functions as a 4-across tap grid — same destinations, new
  // entry points. Users carries the pending-users badge, subsuming the old
  // approvals row that used to sit below the map.
  // ⚠ THE TILES ARE DELIBERATELY MONOCHROME — do not re-introduce per-tile
  // tints. They HAD eight different pastel fills (shipped 9 Aug, frame 1);
  // the owner reviewed both side by side the same day and chose the plain
  // treatment: eight pastel squares in one grid read as confetti and made the
  // screen look cheap. A white tile with a hairline and a blue glyph lets the
  // LABEL do the identifying, which is what a person actually reads here.
  //
  // Colour still earns its place on this screen — it is just spent where it
  // means something: the status figures and the red alert row above.
  const quickTiles: {
    route: string;
    labelKey: string;
    icon: IoniconName;
    count?: number;
  }[] = [
    { route: "AdminIncentiveApprovals", labelKey: "admin.nav.incentiveApprovals", icon: "checkmark-done-outline", count: approvalCount },
    ...(changeRequestsEnabled()
      ? [{ route: "AdminChangeRequests", labelKey: "admin.nav.changeRequests", icon: "git-pull-request-outline" as IoniconName }]
      : []),
    { route: "AdminIncentives", labelKey: "admin.nav.incentives", icon: "cash-outline" },
    { route: "AdminReports", labelKey: "admin.nav.reports", icon: "bar-chart-outline" },
    { route: "AdminSustainability", labelKey: "admin.nav.sustainability", icon: "leaf-outline" },
    { route: "AdminConsignees", labelKey: "admin.nav.consignees", icon: "business-outline" },
    { route: "AdminUsers", labelKey: "admin.users.title", icon: "people-outline", count: pendingCount },
    { route: "AdminPerformance", labelKey: "admin.nav.performance", icon: "trophy-outline" },
    { route: "AdminCalendar", labelKey: "admin.nav.calendar", icon: "calendar-outline" },
    // Failed-delivery / exception lane (feature-gated — hidden while the flag is off).
    ...(exceptionsEnabled() ? [{ route: "AdminExceptions", labelKey: "exception.laneTitle", icon: "warning-outline" as IoniconName }] : []),
  ];

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
    >
      {/* Greeting header — the requestor/driver home header, admin-flavoured.
          ⚠ NO LOGO. The driver and requestor homes carry none, frame 1 drops
          it, and the owner asked for this one to match them (9 Aug 2026). The
          older "headers carry the white mark-only crop" ruling still governs
          the STACK headers (AdminMobileHeader) — it is the greeting home that
          is the exception, on all three apps. Search stays: losing it would be
          a regression, not a redesign. */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerTop}>
          {/* Frame 1: the greeting and the name are ONE line, not two. The
              two-line stack (16px "Good morning" over a 26px name) cost a whole
              row of blue to say something the dispatcher already knows. */}
          <Text numberOfLines={1} style={[styles.greetingLine, { fontSize: greetingFontSize(greetingName(user?.name), 20) }]}>
            {t("admin.home.greetingLine", { name: greetingName(user?.name) })}
          </Text>
          <View style={styles.rolePill}>
            <Ionicons name="shield-checkmark-outline" size={14} color="#fff" />
            <Text style={styles.rolePillText}>{t("admin.home.rolePill")}</Text>
          </View>
          <AdminSearchButton />
        </View>

        {/* "Fri 9 Aug · 6 trips, 8 trucks active" gets its OWN full-width line.
            Sharing the greeting's column left it ~180px once the pill and
            search took their width, which truncated it to "…0 tr…" — the trucks
            figure, the half of the line that changes, was the half being cut.
            The shield lives in the pill now: the role never changes while you
            read it, so it does not belong beside the numbers that do. */}
        <Text numberOfLines={1} style={styles.headerSummary}>
          {k
            ? t("admin.home.headerSummary", {
                date: formatDate(new Date()),
                trips: k.trips_today,
                trucks: k.active_trucks,
              })
            : t("admin.roleLabel")}
        </Text>

        {/* ONE line, the most blocked thing — see lib/adminHome. A dispatcher's
            first question on opening the app is "is anything stuck?"; the
            answer used to be a panel halfway down the scroll. */}
        {strip ? (
          <TouchableOpacity
            style={styles.strip}
            activeOpacity={0.85}
            onPress={() => navigation.navigate("AdminTrips")}
          >
            <Ionicons name="warning" size={17} color={colors.yellow} />
            <Text style={styles.stripText} numberOfLines={2}>
              {t(strip.key, { count: strip.count })}
            </Text>
            <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.content}>
        {/* Floating hero — the dispatcher's live snapshot; taps to the board.
            (Approvals moved down to a normal row — it's not the main job.) */}
        <View style={styles.ctaWrap}>
          <TouchableOpacity
            style={styles.cta}
            activeOpacity={0.9}
            onPress={() => navigation.navigate("AdminTrips")}
          >
            <View style={styles.heroHead}>
              <View style={styles.ctaIcon}>
                <Ionicons name="flash" size={16} color={colors.blue} />
              </View>
              <Text style={styles.ctaTitle}>{t("admin.home.dispatchTitle")}</Text>
              <Ionicons name="chevron-forward" size={20} color={colors.blue} />
            </View>
            <View style={styles.heroStats}>
              <HeroStat value={k ? k.trips_in_progress : null} label={t("admin.home.inProgress")} color={colors.violet} />
              <View style={styles.heroDivider} />
              <HeroStat value={k ? k.awaiting_manual : null} label={t("admin.home.awaitingDispatch")} color={colors.orange} />
              <View style={styles.heroDivider} />
              <HeroStat
                value={k ? k.auto_dispatch_failed : null}
                label={t("admin.trips.needsAttention")}
                color={k && k.auto_dispatch_failed > 0 ? colors.red : colors.green}
              />
            </View>
            {/* Subtle day-progress line — the day's context in one muted row,
                not a second wall of stat boxes. */}
            {k && (
              <View style={styles.heroFooter}>
                <Text style={styles.heroFooterText}>
                  {t("admin.home.daySummary", {
                    trips: k.trips_today,
                    completed: k.completed_today,
                    trucks: k.active_trucks,
                  })}
                </Text>
              </View>
            )}
            {/* The failure named inside the card that counts it — frame 1. The
                count above says "1 needs attention"; this says which kind, so
                the tap has a destination in mind. */}
            {k && k.auto_dispatch_failed > 0 ? (
              <View style={styles.heroAlert}>
                <Ionicons name="warning" size={13} color={colors.red} />
                <Text style={styles.heroAlertText} numberOfLines={2}>
                  {t("admin.home.stripDispatchFailed", { count: k.auto_dispatch_failed })}
                </Text>
                <Ionicons name="chevron-forward" size={13} color={colors.red} />
              </View>
            ) : null}
          </TouchableOpacity>
        </View>

        {/* Quick actions — the important admin functions promoted out of MORE
            as a 4-across tap grid. Same destinations, new entry points.
            ⚠ ORDER: the tiles sit ABOVE the map (owner, 9 Aug). They were
            briefly below it, when the map was promoted during the home
            refinement the same day; the owner reversed that. The tiles are the
            screen's navigation — the map is a status glance — so the thing you
            TAP comes before the thing you LOOK AT. Do not swap them back. */}
        <View style={styles.section}>
          <View style={styles.gridCard}>
            {quickTiles.map((tile) => (
              <TouchableOpacity
                key={tile.route}
                style={styles.tile}
                activeOpacity={0.7}
                // ⚠ fromHome MATTERS. These tiles push into the MORE stack, so
                // without it "back" unwinds to that stack's root — Settings —
                // even though Home is where you were. The header reads this
                // param and returns you to Home instead (see AdminTabs).
                onPress={() =>
                  navigation.navigate("AdminMore", { screen: tile.route, initial: false, params: { fromHome: true } })
                }
              >
                <View style={styles.tileIcon}>
                  <Ionicons name={tile.icon} size={22} color={colors.blue} />
                  {tile.count ? (
                    <View style={styles.tileBadge}>
                      <Text style={styles.tileBadgeText}>{tile.count > 99 ? "99+" : tile.count}</Text>
                    </View>
                  ) : null}
                </View>
                <Text numberOfLines={2} style={styles.tileLabel}>{t(tile.labelKey)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Fleet map — the Phase-3 map, now on the phone home too. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("admin.dashboard.fleetMap")}</Text>
          <View style={styles.mapCard}>
            <View style={styles.mapHead}>
              {/* Only active trucks (with a real fix) are markers now; idle /
                  maintenance moved into the map's Idle side list. */}
              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                <LegendDot color={colors.green} label={t("admin.trucks.statusActive")} />
              </View>
            </View>
            <View style={{ padding: 10 }}>
              {/* ⚠ 280, and do not shrink it again. It was cut to 190 during
                  the 9 Aug home refinement to buy scroll space; the owner asked
                  for it back the same day. The map is the one thing on this
                  screen that is worth its height — a fleet map you have to
                  squint at is not doing its job. Buy space elsewhere. */}
              <AdminFleetMap trucks={trucks.data ?? []} live={live.data ?? []} height={280} idleCollapsed />
            </View>

            {/* ⚠ DO NOT add an idle/"not on the map" list here. AdminFleetMap
                ALREADY renders one — grouped by service class, with count
                pills and collapsible headers. A second copy on this screen
                listed every lorry TWICE (shipped 9 Aug, caught the same day
                from a device screenshot). The frame's "Idle · 1" strip IS that
                component's list; the rule it states lives there too. */}
            <Text style={styles.mapNote}>{t("admin.home.mapCoverageNote")}</Text>
          </View>
        </View>
        {/* Needs attention — same panel as the PC dashboard; hidden when the
            fleet is healthy. "Open trip board" jumps to the Trips tab. */}
        {attentionHasRows(attention.data) && (
          <View style={styles.section}>
            <AttentionPanel report={attention.data} onOpenBoard={() => navigation.navigate("AdminTrips")} />
          </View>
        )}

        {/* Sustainability card removed on NARROW (owner, 28 Jul): the
            quick-action grid tile above is the entry point, and the card only
            showed dashes here. The card stays on WIDE (DashboardWide). */}


      </View>
    </ScrollView>
  );
}

function HeroStat({ value, label, color }: { value: number | null; label: string; color: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center" }}>
      <Text style={{ fontSize: 34, fontWeight: "900", lineHeight: 38, color }}>{value ?? "—"}</Text>
      <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textMuted, textAlign: "center", marginTop: 6 }}>
        {label}
      </Text>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
      <Text style={{ fontSize: font.xs, color: colors.textMuted }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 44 },
  headerTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  // Frame 1's header type: one 20px line for the greeting, one 13px line for
  // the day. (The driver/requestor homes keep their two-line stack — this is
  // the admin frame, and the admin header carries a summary they do not.)
  greetingLine: { flex: 1, minWidth: 0, color: "#fff", fontSize: 20, fontWeight: "800", lineHeight: 25 },
  headerSummary: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", marginTop: 8 },
  rolePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.14)",
    paddingVertical: 6,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
  },
  rolePillText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderWidth: 2,
    borderColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 15, fontWeight: "800" },

  // Wide screens center the content column like the other admin screens.
  content: { width: "100%", maxWidth: 1000, alignSelf: "center" },

  ctaWrap: { paddingHorizontal: 20, marginTop: -28 },
  cta: {
    backgroundColor: "#fff",
    borderRadius: radius.lg,
    padding: 16,
    gap: 12,
    ...shadow.floating,
  },
  heroHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  heroStats: { flexDirection: "row", alignItems: "center" },
  heroDivider: { width: 1, alignSelf: "stretch", backgroundColor: colors.divider },
  heroFooter: { borderTopWidth: 1, borderTopColor: colors.divider, marginTop: 8, paddingTop: 8, alignItems: "center" },
  heroFooterText: { fontSize: font.sm, color: colors.textMuted, fontWeight: "600" },
  ctaIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  ctaTitle: { flex: 1, fontSize: font.lg, fontWeight: "700", color: colors.navy },
  countPill: { backgroundColor: colors.red, borderRadius: radius.pill, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  countPillText: { color: "#fff", fontSize: font.xs, fontWeight: "800" },

  // More air between blocks — the sections used to sit 16px apart, which
  // made three unrelated things read as one column of noise.
  section: { paddingHorizontal: 16, paddingTop: 24 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },

  rowCard: { backgroundColor: colors.card, borderRadius: radius.lg, marginTop: 4, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.blueTint, alignItems: "center", justifyContent: "center" },
  rowLabel: { fontSize: font.md, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: font.sm, color: colors.textFaint, marginTop: 1 },

  mapCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 12,
    overflow: "hidden",
    ...shadow.card,
  },
  mapHead: {
    paddingTop: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  mapSub: { fontSize: font.sm, color: colors.textMuted, flexShrink: 1 },

  // Quick-action grid — Shopee/TNG-style tap tiles, 4 across (last row of 3
  // left-aligns). Each tile is 25% wide so 4 fit per row exactly.
  gridCard: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    marginTop: 4,
    ...shadow.card,
  },
  tile: { width: "25%", alignItems: "center", paddingVertical: 10, paddingHorizontal: 4 },
  // White with a hairline, NOT a tinted fill — see the note on quickTiles.
  tileIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  tileBadge: {
    position: "absolute",
    top: -5,
    right: -5,
    backgroundColor: colors.red,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.card,
  },
  tileBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  tileLabel: { fontSize: 11, fontWeight: "600", color: colors.text, textAlign: "center", marginTop: 6, lineHeight: 14 },

  // Attention strip on the blue (frame 1).
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginTop: 14,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  stripText: { flex: 1, color: "#fff", fontSize: font.sm, fontWeight: "700" },
  // The map component owns the idle LIST; this states the rule beneath it.
  mapNote: { paddingHorizontal: 14, paddingVertical: 10, fontSize: font.xs, color: colors.textFaint, lineHeight: 16, borderTopWidth: 1, borderTopColor: colors.divider },

  // The named failure inside the card that counts it.
  heroAlert: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFF5F5",
    borderWidth: 1,
    borderColor: "#f3c2c0",
    borderRadius: 11,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 2,
  },
  heroAlertText: { flex: 1, fontSize: font.xs, fontWeight: "700", color: colors.text, lineHeight: 16 },

});
