import React from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import { colors } from "../theme";
import { PLANT_ORIGIN, regionFor, zoneCoord } from "../lib/geo";

// Approximate map: UWC plant → destination-zone centroid with a straight line.
// No GPS this phase, so it's illustrative (see lib/geo.ts). We use the default
// map provider so it works in Expo Go without a Google Maps API key.
export function TripMap({
  destZone,
  height = 240,
  pointerEvents = "none",
}: {
  destZone?: string | null;
  height?: number;
  pointerEvents?: "auto" | "none";
}) {
  const dest = zoneCoord(destZone);
  const region = regionFor(PLANT_ORIGIN, dest);

  return (
    <View style={{ height }} pointerEvents={pointerEvents}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={region}>
        <Marker coordinate={PLANT_ORIGIN} title="UWC Batu Kawan" pinColor={colors.blue} />
        <Marker coordinate={dest} title="Destination" pinColor={colors.red} />
        <Polyline
          coordinates={[PLANT_ORIGIN, dest]}
          strokeColor={colors.blue}
          strokeWidth={4}
          lineDashPattern={[10, 6]}
        />
      </MapView>
    </View>
  );
}
