// Admin fleet map — NATIVE build (react-native-maps; the web build resolves
// map.web.tsx with Leaflet instead). Same visual language as the web admin's
// FleetMap: zone catchment circles with code labels, the plant marker, and
// per-truck markers on a real GPS fix (solid pill + live dot) or the zone
// centroid (dashed pill). Same props on both platforms.
// NOTE: the Android Google-Maps key is a known-open item — until it's set,
// Android renders a blank map (same as the driver/requestor maps).
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Callout, Circle, Marker } from "react-native-maps";
import { useTranslation } from "react-i18next";
import { MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES, truckPosition } from "../lib/zones";
import { formatTime } from "../lib/format";
import { colors, font } from "../theme";
import type { LivePosition, Truck } from "../types";

const truckColor: Record<string, string> = {
  active: colors.green,
  idle: colors.blue,
  maintenance: colors.orange,
};

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
}: {
  trucks: Truck[];
  live?: LivePosition[];
  height?: number;
}) {
  const { t } = useTranslation();
  const liveByPlate = new Map(live.map((p) => [p.plate, p]));

  return (
    <View style={{ height, borderRadius: 12, overflow: "hidden" }}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={REGION}>
        {/* Zone overlays */}
        {ZONES.map((z) => (
          <React.Fragment key={z.code}>
            <Circle
              center={{ latitude: z.lat, longitude: z.lng }}
              radius={9000}
              strokeColor={z.color}
              strokeWidth={1.5}
              fillColor={`${z.color}1F`}
            />
            <Marker coordinate={{ latitude: z.lat, longitude: z.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
              <Text style={{ color: z.color, fontWeight: "800", fontSize: font.md }}>{z.code}</Text>
            </Marker>
          </React.Fragment>
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

        {/* Trucks */}
        {trucks.map((tr) => {
          const fix = liveByPlate.get(tr.plate);
          const isLive = Boolean(fix) && !fix!.stale;
          const [lat, lng] = fix
            ? [fix.latitude, fix.longitude]
            : truckPosition(tr.plate, tr.priority_zones);
          const color = truckColor[tr.status] ?? colors.blue;

          return (
            <Marker key={tr.plate} coordinate={{ latitude: lat, longitude: lng }} tracksViewChanges={false}>
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
                      ? `● ${t("admin.dashboard.mapLive", { time: formatTime(fix!.recorded_at) })}`
                      : fix
                        ? t("admin.dashboard.mapStale")
                        : t("admin.dashboard.mapApprox")}
                  </Text>
                </View>
              </Callout>
            </Marker>
          );
        })}
      </MapView>
    </View>
  );
}
