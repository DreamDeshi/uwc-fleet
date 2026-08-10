// Admin fleet map — NATIVE build (react-native-maps; the web build resolves
// map.web.tsx with Leaflet instead). Zone code labels, the plant marker, and
// per-truck markers — but ONLY for trucks with a real GPS fix (on an in-progress
// trip that has pinged, live or stale/last-known). Trucks with no live position
// are NOT drawn at a fake coordinate; they sit in the "Idle" list beside the map.
// Same props and same treatment on both platforms — keep the two files in step.
// Zone catchment circles removed 2026-07-20 (never real boundaries, one
// hardcoded 9km radius for every zone) — see map.web.tsx header for the detail.
// (The Android Google-Maps key is configured in app.json since 22 Jul 2026 —
// the old "blank map until the key is set" caveat no longer applies.)
import React, { useEffect, useRef, useState } from "react";
import { ImageRequireSource, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import MapView, { Callout, Marker } from "react-native-maps";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useWide } from "../../hooks/useWide";
import { FOCUS_ZOOM, MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES } from "../lib/zones";
import { formatTime } from "../lib/format";
import { groupFleet, type FleetGroup } from "../lib/fleetGroups";
import { colors, font } from "../theme";
import type { LivePosition, Truck } from "../types";

const truckColor: Record<string, string> = {
  active: colors.green,
  idle: colors.blue,
  maintenance: colors.orange,
};

// Status tag shown on each Idle-list row. Reuses the existing admin.trucks.*
// status strings + theme tints — no new palette, no new copy.
function statusTag(status: string): { bg: string; fg: string; labelKey: string } {
  switch (status) {
    case "active":
      return { bg: colors.greenTint, fg: colors.green, labelKey: "admin.trucks.statusActive" };
    case "maintenance":
      return { bg: colors.orangeTint, fg: colors.orange, labelKey: "admin.trucks.statusMaintenance" };
    case "retired":
      return { bg: colors.bg, fg: colors.textMuted, labelKey: "admin.trucks.statusRetired" };
    default: // "idle"
      return { bg: colors.blueTint, fg: colors.blue, labelKey: "admin.trucks.statusIdle" };
  }
}

// Compact tinted count pill for the service-class group headers.
function CountPill({ bg, fg, label }: { bg: string; fg: string; label: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ color: fg, fontSize: 9.5, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

// Leaflet zoom 8 over the operating region ≈ a ~2° span.
const REGION = {
  latitude: MAP_CENTER[0],
  longitude: MAP_CENTER[1],
  latitudeDelta: 2.0,
  longitudeDelta: 2.0,
};
void MAP_ZOOM; // parity note: web uses the zoom directly

// react-native-maps frames by DELTA, Leaflet by zoom level, so the shared
// FOCUS_ZOOM has to be converted rather than passed through: the world is 360°
// across at zoom 0 and halves each level, so delta = 360 / 2**zoom. Deriving it
// keeps the two builds pointed at the same tightness from ONE constant instead
// of a magic number here that silently drifts from the web's.
const FOCUS_DELTA = 360 / 2 ** FOCUS_ZOOM;
const focusRegion = (latitude: number, longitude: number) => ({
  latitude,
  longitude,
  latitudeDelta: FOCUS_DELTA,
  longitudeDelta: FOCUS_DELTA,
});

// STATIC markers are pre-rendered PNGs (e2e/tools/gen-map-marker-assets.mjs
// renders the exact web divIcon CSS → pixel parity by construction). WHY:
// react-native-maps 1.20 under the new architecture allocates a custom-view
// Marker's bitmap at a constant default size regardless of layout — the
// plant-pin saga's real root cause (device-verified, 27 Jul 2026). The
// `image` prop bypasses the view-snapshot path entirely. Dynamic truck
// pills can't be static images; they need the react-native-maps upgrade
// that ships with the NEXT APK (native change).
const PLANT_PIN_IMAGE = require("../../../assets/map/plant-pin.png");
const ZONE_LABEL_IMAGES: Record<string, ImageRequireSource> = {
  P1: require("../../../assets/map/zone-P1.png"),
  P2: require("../../../assets/map/zone-P2.png"),
  P3: require("../../../assets/map/zone-P3.png"),
  K1: require("../../../assets/map/zone-K1.png"),
  K2: require("../../../assets/map/zone-K2.png"),
  A1: require("../../../assets/map/zone-A1.png"),
  A2: require("../../../assets/map/zone-A2.png"),
  KL: require("../../../assets/map/zone-KL.png"),
};

// Android + custom-view Markers: with tracksViewChanges={false} Google Maps
// rasterizes the marker view ONCE — and it can snapshot BEFORE React Native
// has laid the view out, leaving an INVISIBLE marker. That is exactly the
// APK bug where the UWC PLANT pin (and the zone labels) never appeared even
// though the code below always rendered them. Fix: keep tracking ON just
// long enough for the first real paint, then freeze for battery/perf. Re-arm
// whenever the live-fix data changes so a truck pill that flips live↔stale
// (dashed border / green dot) re-rasterizes its new look.
const MARKER_FREEZE_DELAY_MS = 700;
function useMarkerFreeze(dep: unknown): boolean {
  const [tracking, setTracking] = useState(true);
  useEffect(() => {
    setTracking(true);
    const t = setTimeout(() => setTracking(false), MARKER_FREEZE_DELAY_MS);
    return () => clearTimeout(t);
  }, [dep]);
  return tracking;
}

export function AdminFleetMap({
  trucks,
  live = [],
  height = 400,
  fill = false,
  idleCollapsed = false,
  idleOverlay = false,
}: {
  trucks: Truck[];
  live?: LivePosition[];
  height?: number;
  // ONE summary line instead of the full list (admin Home). The list is the
  // right thing on the Fleet screen, where you went looking for lorries; on
  // Home it was the tallest block on the page and made the screen feel like it
  // never ended. Collapsed by default here, one tap to open — nothing is
  // hidden, it just stops being the first thing you scroll past.
  idleCollapsed?: boolean;
  // Put the idle roster ON the map (bottom-left) instead of in a column beside
  // it, so the map gets the card's full width. WIDE ONLY — on a phone the map
  // is 280px tall and a panel over it would swamp the thing it annotates, so
  // narrow keeps the stacked list. Parity with map.web.tsx.
  idleOverlay?: boolean;
  // fill: take the parent's full height (flex:1) instead of a fixed px height —
  // used where the map sits in a stretched card beside a taller rail.
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const isWide = useWide();
  const tracksViewChanges = useMarkerFreeze(live);
  // Frame the trucks that are actually out there — parity with map.web.tsx's
  // FitToFleet; see the reasoning in that file. A fixed region is always wrong
  // for somebody: wide enough for Ipoh makes Penang a smudge, tight enough for
  // Penang loses Ipoh.
  const mapRef = useRef<MapView | null>(null);
  const fitKey = live.map((p) => `${p.latitude},${p.longitude}`).join("|");
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (live.length === 0) {
      m.animateToRegion(REGION, 300);
      return;
    }
    // The PLANT is always included so the frame never floats off the depot.
    m.fitToCoordinates(
      [{ latitude: PLANT_ORIGIN.lat, longitude: PLANT_ORIGIN.lng }, ...live.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))],
      { edgePadding: { top: 48, right: 48, bottom: 48, left: 48 }, animated: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  const focus = (latitude: number, longitude: number) =>
    mapRef.current?.animateToRegion(focusRegion(latitude, longitude), 350);
  const liveByPlate = new Map(live.map((p) => [p.plate, p]));
  // A truck gets a map marker ONLY when it has a real fix (live or stale). Every
  // other truck has no live position and must never be drawn at a fake
  // coordinate: it goes to the Idle list instead.
  const active = trucks.filter((tr) => liveByPlate.has(tr.plate));
  const idle = trucks.filter((tr) => !liveByPlate.has(tr.plate));

  // Service-class grouping (28 Jul design) — NARROW ONLY, and only once the
  // fleet actually has two classes (INTERPLANT_PLATES is empty until the
  // on-hold fleet update ships, so `grouped` is false today and the flat list
  // below renders exactly as before — the ship-early contract).
  const groups = groupFleet(trucks, (p) => liveByPlate.has(p));
  const grouped = !isWide && groups.length > 1;
  // Home passes idleCollapsed, the desktop dashboard passes idleOverlay. Both
  // drive the SAME `idleOpen` state — one is a line above the map, the other a
  // chip on it, and neither hides a truck that the other would show.
  const [idleOpen, setIdleOpen] = useState(false);
  // Narrow falls back to the stacked list: an overlay on a 280px-tall phone map
  // would cover the thing it annotates.
  const overlayMode = idleOverlay && isWide;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    customer: true, // the dispatch pool — open by default
    interplant: false, // two dedicated shuttles — folded, counts still visible
  });

  const renderIdleRow = (tr: Truck) => {
    const tag = statusTag(tr.status);
    // ⚠ THE PILL MARKS THE EXCEPTION, NOT THE RULE. Every row in this list is
    // off the map, and on a quiet fleet that is the whole fleet — so tagging
    // each one "Idle" printed the same pill seven times while the group header
    // already said "7 idle". Seven identical pills is noise that hides the one
    // truck that is actually different, which is the only reason to scan here.
    const exceptional = tr.status !== "idle";
    return (
      <View
        key={tr.plate}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderBottomWidth: 1,
          borderBottomColor: colors.divider,
        }}
      >
        {/* A leading glyph so the column reads as vehicles at a glance rather
            than as a wall of blue text. */}
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            backgroundColor: exceptional ? tag.bg : colors.blueTint,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="bus" size={13} color={exceptional ? tag.fg : colors.blue} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontWeight: "700", fontSize: 13, color: colors.navy }}>{tr.plate}</Text>
          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textMuted }}>
            {tr.type}
            {tr.driver ? ` · ${tr.driver.name}` : ""}
          </Text>
        </View>
        {exceptional ? (
          <View style={{ backgroundColor: tag.bg, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
            <Text style={{ color: tag.fg, fontSize: 10, fontWeight: "700" }}>{t(tag.labelKey)}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  // Header count pills — RECONCILIATION RULE: activeOnMap counts trucks that
  // are map markers (not rows), so every class header always totals the whole
  // class (pinned in lib/fleetGroups.test.ts).
  const renderGroupHeader = (g: FleetGroup, open: boolean) => (
    <Pressable
      key={`${g.key}-head`}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpenGroups((s) => ({ ...s, [g.key]: !open }))}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 9,
        backgroundColor: "#fafbfe",
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Text style={{ width: 12, fontSize: 11, fontWeight: "700", color: colors.textFaint }}>{open ? "▾" : "▸"}</Text>
      <Text style={{ fontSize: 12, fontWeight: "800", color: colors.text }}>{t(`admin.fleetGroups.${g.key}`)}</Text>
      {g.key === "interplant" ? (
        <Text numberOfLines={1} style={{ fontSize: 10, color: colors.textFaint, flexShrink: 1 }}>
          {t("admin.fleetGroups.interplantSub")}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      {g.activeOnMap > 0 && <CountPill bg={colors.greenTint} fg={colors.green} label={t("admin.fleetGroups.countActive", { n: g.activeOnMap })} />}
      {g.counts.idle > 0 && <CountPill bg={colors.blueTint} fg={colors.blue} label={t("admin.fleetGroups.countIdle", { n: g.counts.idle })} />}
      {g.counts.maintenance > 0 && <CountPill bg={colors.orangeTint} fg={colors.orange} label={t("admin.fleetGroups.countMaintenance", { n: g.counts.maintenance })} />}
      {g.counts.retired > 0 && <CountPill bg={colors.bg} fg={colors.textMuted} label={t("admin.fleetGroups.countRetired", { n: g.counts.retired })} />}
    </Pressable>
  );

  return (
    <View
      style={{
        flexDirection: isWide ? "row" : "column",
        gap: 12,
        ...(fill ? { flex: 1 } : isWide ? { height } : {}),
      }}
    >
      <View style={isWide ? { flex: 1, borderRadius: 12, overflow: "hidden" } : { height, borderRadius: 12, overflow: "hidden" }}>
        <MapView ref={mapRef} style={StyleSheet.absoluteFill} initialRegion={REGION}>
          {/* Zone code labels only — no catchment circles.
              DETERMINISTIC MARKER GEOMETRY (27 Jul 2026, third and final
              layer of the plant-pin saga — device-screenshot diagnosis):
              Android allocates the marker's bitmap at the child view's FIRST
              measure and never grows it when async text layout widens the
              view. The canvas is top-left anchored, so the label clipped at
              the right (left rounded corner intact) and the centered square
              below fell outside it entirely except its navy border sliver.
              Rule: every marker child's ROOT has EXPLICIT width/height —
              first measure == final size, no async text measure in the
              critical path. Inner content hugs freely inside the fixed box.
              Sizes mirror the web divIcon iconSize boxes; type stays fixed
              10px unscaled (allowFontScaling={false}) so it always fits. */}
          {ZONES.map((z) => {
            const img = ZONE_LABEL_IMAGES[z.code];
            return img ? (
              <Marker
                key={z.code}
                coordinate={{ latitude: z.lat, longitude: z.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
                image={img}
              />
            ) : (
              // Fallback for a zone code without a generated asset (should not
              // happen — regenerate via e2e/tools/gen-map-marker-assets.mjs).
              <Marker
                key={z.code}
                coordinate={{ latitude: z.lat, longitude: z.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
                tracksViewChanges={tracksViewChanges}
              >
                <View collapsable={false} style={{ width: 44, height: 18, alignItems: "center", justifyContent: "center" }}>
                  <Text
                    allowFontScaling={false}
                    numberOfLines={1}
                    style={{ color: z.color, fontWeight: "800", fontSize: font.sm, opacity: 0.75 }}
                  >
                    {z.code}
                  </Text>
                </View>
              </Marker>
            );
          })}

          {/* Plant origin — pre-rendered image, bottom-center anchored (the
              yellow square's base sits on the coordinate, like the web icon). */}
          <Marker
            coordinate={{ latitude: PLANT_ORIGIN.lat, longitude: PLANT_ORIGIN.lng }}
            anchor={{ x: 0.5, y: 1 }}
            image={PLANT_PIN_IMAGE}
          />

          {/* Active trucks — every one sits on a real GPS fix (live or stale) */}
          {active.map((tr) => {
            const fix = liveByPlate.get(tr.plate)!;
            const isLive = !fix.stale;
            const color = truckColor[tr.status] ?? colors.blue;

            return (
              <Marker
                key={tr.plate}
                coordinate={{ latitude: fix.latitude, longitude: fix.longitude }}
                anchor={{ x: 0.5, y: 1 }}
                tracksViewChanges={tracksViewChanges}
                zIndex={2}
                // Tap a truck to go to it — parity with the web build. The
                // callout still opens; this only moves the camera under it.
                onPress={() => focus(fix.latitude, fix.longitude)}
              >
                {/* INTERIM truck marker (owner decision, 27 Jul 2026): a plain
                    colored dot small enough to fit the Fabric bug's constant
                    ~36dp canvas — better a simple dot that works than a
                    broken plate pill. Live = full-strength ring; stale =
                    faded. The plate and every detail stay in the tap
                    callout, and the idle side list still names plates.
                    RESTORE the full plate pill when the react-native-maps
                    upgrade ships in the next APK (native, runtime bump). */}
                <View collapsable={false} style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      backgroundColor: color,
                      borderWidth: 2,
                      borderColor: "#fff",
                      opacity: isLive ? 1 : 0.45,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {isLive ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#fff" }} /> : null}
                  </View>
                </View>
                <Callout tooltip={false}>
                  <View style={{ minWidth: 170, padding: 4 }}>
                    <Text style={{ fontSize: font.sm, color: colors.text }}>
                      <Text style={{ fontWeight: "700" }}>{tr.plate}</Text> · {tr.type}
                    </Text>
                    <Text style={{ fontSize: font.sm, color: colors.text }}>{tr.driver?.name ?? t("admin.dashboard.mapNoDriver")}</Text>
                    <Text style={{ fontSize: font.sm, color: colors.text }}>
                      {t("admin.dashboard.loadPallets", { load: tr.current_load, capacity: tr.max_pallets })}
                    </Text>
                    <Text style={{ fontSize: font.sm, fontWeight: "700", color: isLive ? colors.green : colors.textMuted }}>
                      {isLive
                        ? `● ${t("admin.dashboard.mapLive", { time: formatTime(fix.recorded_at) })}`
                        : t("admin.dashboard.mapStale")}
                    </Text>
                  </View>
                </Callout>
              </Marker>
            );
          })}
        </MapView>
        {/* Jump to the plant — small and out of the way, parity with the web
            build's overlay button. Absolute over the MapView so it does not
            take height from the map itself. */}
        <Pressable
          onPress={() => focus(PLANT_ORIGIN.lat, PLANT_ORIGIN.lng)}
          accessibilityRole="button"
          accessibilityLabel={t("admin.dashboard.focusPlant")}
          hitSlop={8}
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            paddingVertical: 5,
            paddingHorizontal: 8,
          }}
        >
          <View style={{ width: 9, height: 9, backgroundColor: colors.yellow, borderWidth: 2, borderColor: colors.navy, borderRadius: 2 }} />
          <Text style={{ fontSize: 11, fontWeight: "700", color: colors.navy }}>
            {t("admin.dashboard.focusPlantShort")}
          </Text>
        </Pressable>
        {/* The idle roster, ON the map — parity with map.web.tsx; see the
            reasoning there. Collapsed it is a chip in the plant button's
            language, open the SAME element grows downward into a scrollable
            panel. TOP-LEFT under the zoom control, not bottom-left: the card
            stretches to the right rail and its bottom falls below the fold, so
            a bottom-anchored chip needed a scroll to reach. */}
        {overlayMode && idle.length > 0 && (
          <View
            style={{
              position: "absolute",
              left: 10,
              top: 84,
              // Closed it hugs its text like the plant button it echoes.
              width: idleOpen ? 208 : undefined,
              // Fixed, not a percentage — the card is taller than the viewport,
              // so a percentage cap put the panel's last row below the fold.
              maxHeight: 360,
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: idleOpen }}
              accessibilityLabel={`${t("admin.fleetGroups.countIdle", { n: idle.length })} · ${t("admin.fleetGroups.notTracked")}`}
              onPress={() => setIdleOpen((v) => !v)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                paddingHorizontal: 9,
                paddingVertical: 7,
                borderBottomWidth: idleOpen ? 1 : 0,
                borderBottomColor: colors.border,
              }}
            >
              <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.blue }} />
              <Text style={{ flex: idleOpen ? 1 : undefined, fontSize: 11, fontWeight: "700", color: colors.navy }}>
                {t("admin.fleetGroups.countIdle", { n: idle.length })}
              </Text>
              <Text style={{ fontSize: 10, color: colors.textFaint }}>{idleOpen ? "▴" : "▾"}</Text>
            </Pressable>
            {idleOpen && <ScrollView nestedScrollEnabled>{idle.map(renderIdleRow)}</ScrollView>}
          </View>
        )}
      </View>

      {/* Idle trucks: no live position → NOT on the map. Compact side list
          (narrow column on wide, stacked below on phone). Hidden when the whole
          fleet is active, so the map takes the full width.
          NARROW HAS NO HEIGHT CAP (28 Jul fix): the old maxHeight:190 showed
          ~3 rows, and the nested vertical ScrollView cannot scroll inside the
          page ScrollView on Android — trucks 4..N were unreachable on the APK
          (web survived only because CSS overflow scrolls). The fleet is ≤8
          rows, so on phones the list renders in full and the PAGE scrolls;
          the wide sidebar keeps its own scroll (nestedScrollEnabled for the
          Android case). */}
      {!overlayMode && idle.length > 0 && idleCollapsed && !idleOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: false }}
          onPress={() => setIdleOpen(true)}
          style={{
            flexDirection: "row", alignItems: "center", gap: 9,
            backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
            borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11,
          }}
        >
          <View style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: colors.blueTint,
                         alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 12, color: colors.blue, fontWeight: "800" }}>{idle.length}</Text>
          </View>
          <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "700", color: colors.text }}>
            {t("admin.trucks.statusIdle")} · {t("admin.fleetGroups.notTracked")}
          </Text>
          <Text style={{ fontSize: 12, fontWeight: "700", color: colors.blue }}>{t("admin.fleetGroups.showAll")}</Text>
        </Pressable>
      ) : null}
      {!overlayMode && idle.length > 0 && (!idleCollapsed || idleOpen) && (
        <View
          style={{
            width: isWide ? 190 : undefined,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {grouped ? (
            // NARROW + two service classes: collapsible group headers whose
            // count pills always total the whole class (map trucks included).
            groups.map((g) => {
              const open = openGroups[g.key] ?? false;
              return (
                <React.Fragment key={g.key}>
                  {renderGroupHeader(g, open)}
                  {open && g.rows.map(renderIdleRow)}
                </React.Fragment>
              );
            })
          ) : (
            // Single class (today's fleet) or the WIDE sidebar: the flat list,
            // byte-identical to the pre-grouping behaviour.
            <>
              <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                <Text style={{ fontWeight: "700", fontSize: 12, color: colors.text }}>
                  {t("admin.trucks.statusIdle")} · {idle.length}
                </Text>
              </View>
              <ScrollView nestedScrollEnabled>{idle.map(renderIdleRow)}</ScrollView>
            </>
          )}
        </View>
      )}
    </View>
  );
}
