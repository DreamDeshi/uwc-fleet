import React from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { colors } from "../theme";
import { PLANT_ORIGIN } from "../lib/geo";
import { mapsEnabled } from "../lib/maps";
import { MapPlaceholder } from "./MapPlaceholder";

type LatLng = { latitude: number; longitude: number };

// Full-screen hero map for the driver's active trip. Extracted from
// ActiveTripScreen so the web build can swap in a maps-free fallback
// (ActiveTripMap.web.tsx) — react-native-maps does not bundle for web.
export function ActiveTripMap({
  region,
  dest,
  destLabel,
  current,
}: {
  region: any;
  dest: LatLng;
  destLabel: string;
  current?: LatLng | null;
}) {
  // Falls back to a placeholder when no Google Maps API key is configured,
  // since MapView would crash the Android app at mount. See lib/maps.ts.
  if (!mapsEnabled) return <MapPlaceholder style={StyleSheet.absoluteFill} />;

  return (
    <MapView style={StyleSheet.absoluteFill} initialRegion={region}>
      <Marker coordinate={PLANT_ORIGIN} title="UWC Batu Kawan" pinColor={colors.blue} />
      <Marker coordinate={dest} title={destLabel} pinColor={colors.red} />
      {/* ⚠ NO ROUTE LINE HERE. Owner ruling, 18 Aug 2026 — the geometry is
          PLANT-anchored, so once he is moving it is wrong at both ends. See
          ActiveTripMap.web.tsx for the full reasoning; the pre-trip map
          (LiveTripMap) keeps the line. */}
      {/* Live "you are here" dot from this phone's GPS */}
      {current ? (
        <Marker coordinate={current} anchor={{ x: 0.5, y: 0.5 }} flat>
          <View style={styles.liveDotRing}>
            <View style={styles.liveDotCore} />
          </View>
        </Marker>
      ) : null}
    </MapView>
  );
}

const styles = StyleSheet.create({
  liveDotRing: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(0,48,135,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  liveDotCore: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.blue,
    borderWidth: 2,
    borderColor: colors.white,
  },
});
