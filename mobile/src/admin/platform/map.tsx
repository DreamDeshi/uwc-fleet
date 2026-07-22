// Admin fleet map — NATIVE build (react-native-maps; the web build resolves
// map.web.tsx with Leaflet instead). Zone code labels, the plant marker, and
// per-truck markers — but ONLY for trucks with a real GPS fix (on an in-progress
// trip that has pinged, live or stale/last-known). Trucks with no live position
// are NOT drawn at a fake coordinate; they sit in the "Idle" list beside the map.
// Same props and same treatment on both platforms — keep the two files in step.
// Zone catchment circles removed 2026-07-20 (never real boundaries, one
// hardcoded 9km radius for every zone) — see map.web.tsx header for the detail.
// NOTE: the Android Google-Maps key is a known-open item — until it's set,
// Android renders a blank map (same as the driver/requestor maps).
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import MapView, { Callout, Marker } from "react-native-maps";
import { useTranslation } from "react-i18next";
import { useWide } from "../../hooks/useWide";
import { MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES } from "../lib/zones";
import { formatTime } from "../lib/format";
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

// Leaflet zoom 8 over the operating region ≈ a ~2° span.
const REGION = {
  latitude: MAP_CENTER[0],
  longitude: MAP_CENTER[1],
  latitudeDelta: 2.0,
  longitudeDelta: 2.0,
};
void MAP_ZOOM; // parity note: web uses the zoom directly

export function AdminFleetMap({
  trucks,
  live = [],
  height = 400,
  fill = false,
}: {
  trucks: Truck[];
  live?: LivePosition[];
  height?: number;
  // fill: take the parent's full height (flex:1) instead of a fixed px height —
  // used where the map sits in a stretched card beside a taller rail.
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const isWide = useWide();
  const liveByPlate = new Map(live.map((p) => [p.plate, p]));
  // A truck gets a map marker ONLY when it has a real fix (live or stale). Every
  // other truck has no live position and must never be drawn at a fake
  // coordinate: it goes to the Idle list instead.
  const active = trucks.filter((tr) => liveByPlate.has(tr.plate));
  const idle = trucks.filter((tr) => !liveByPlate.has(tr.plate));

  return (
    <View
      style={{
        flexDirection: isWide ? "row" : "column",
        gap: 12,
        ...(fill ? { flex: 1 } : isWide ? { height } : {}),
      }}
    >
      <View style={isWide ? { flex: 1, borderRadius: 12, overflow: "hidden" } : { height, borderRadius: 12, overflow: "hidden" }}>
        <MapView style={StyleSheet.absoluteFill} initialRegion={REGION}>
          {/* Zone code labels only — no catchment circles */}
          {ZONES.map((z) => (
            <Marker
              key={z.code}
              coordinate={{ latitude: z.lat, longitude: z.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <Text style={{ color: z.color, fontWeight: "800", fontSize: font.sm, opacity: 0.75 }}>{z.code}</Text>
            </Marker>
          ))}

          {/* Plant origin */}
          <Marker coordinate={{ latitude: PLANT_ORIGIN.lat, longitude: PLANT_ORIGIN.lng }} tracksViewChanges={false}>
            <View style={{ alignItems: "center" }}>
              <View style={{ backgroundColor: colors.navy, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, marginBottom: 3 }}>
                <Text style={{ color: colors.yellow, fontSize: 10, fontWeight: "700" }}>UWC PLANT</Text>
              </View>
              <View style={{ width: 16, height: 16, backgroundColor: colors.yellow, borderWidth: 3, borderColor: colors.navy, borderRadius: 3 }} />
            </View>
          </Marker>

          {/* Active trucks — every one sits on a real GPS fix (live or stale) */}
          {active.map((tr) => {
            const fix = liveByPlate.get(tr.plate)!;
            const isLive = !fix.stale;
            const color = truckColor[tr.status] ?? colors.blue;

            return (
              <Marker
                key={tr.plate}
                coordinate={{ latitude: fix.latitude, longitude: fix.longitude }}
                tracksViewChanges={false}
                zIndex={2}
              >
                <View style={{ alignItems: "center" }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      backgroundColor: "#fff",
                      borderWidth: 1.5,
                      borderColor: color,
                      borderStyle: isLive ? "solid" : "dashed",
                      borderRadius: 6,
                      paddingHorizontal: 6,
                      paddingVertical: 1,
                      marginBottom: 3,
                    }}
                  >
                    {isLive && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green, marginRight: 4 }} />}
                    <Text style={{ color: colors.navy, fontSize: 10, fontWeight: "700" }}>{tr.plate}</Text>
                  </View>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      backgroundColor: color,
                      borderWidth: 2,
                      borderColor: "#fff",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 10 }}>🚚</Text>
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
      </View>

      {/* Idle trucks: no live position → NOT on the map. Compact side list
          (narrow column on wide, stacked below on phone). Hidden when the whole
          fleet is active, so the map takes the full width. */}
      {idle.length > 0 && (
        <View
          style={{
            width: isWide ? 190 : undefined,
            maxHeight: isWide ? undefined : 190,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={{ fontWeight: "700", fontSize: 12, color: colors.text }}>
              {t("admin.trucks.statusIdle")} · {idle.length}
            </Text>
          </View>
          <ScrollView>
            {idle.map((tr) => {
              const tag = statusTag(tr.status);
              return (
                <View
                  key={tr.plate}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.divider,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontWeight: "700", fontSize: 13, color: colors.navy }}>{tr.plate}</Text>
                    <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textMuted }}>
                      {tr.type}
                      {tr.driver ? ` · ${tr.driver.name}` : ""}
                    </Text>
                  </View>
                  <View style={{ backgroundColor: tag.bg, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
                    <Text style={{ color: tag.fg, fontSize: 10, fontWeight: "700" }}>{t(tag.labelKey)}</Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
