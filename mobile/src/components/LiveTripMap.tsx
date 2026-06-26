import React from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import { colors } from "../theme";
import { PLANT_ORIGIN, regionFor, zoneCoord } from "../lib/geo";
import { mapsEnabled } from "../lib/maps";
import { MapPlaceholder } from "./MapPlaceholder";
import { useTripRoute, useTripLatestLocation } from "../hooks/queries";

// Live overview map for tracking a trip: UWC plant → destination drawn with the
// real road path (Google Directions, computed server-side) plus a truck dot that
// moves as the driver's phone reports its position. Map gestures are disabled so
// it sits cleanly inside a scrolling detail screen. Replaces the old approximate
// straight-line TripMap.
export function LiveTripMap({
  tripId,
  destZone,
  live = true,
  height = 200,
}: {
  tripId: string;
  destZone?: string | null;
  live?: boolean; // poll the truck's position — true only while in transit
  height?: number;
}) {
  const dest = zoneCoord(destZone);
  const region = regionFor(PLANT_ORIGIN, dest);
  const { data: route } = useTripRoute(tripId, true);
  const { data: pos } = useTripLatestLocation(tripId, live);

  if (!mapsEnabled) {
    return <MapPlaceholder style={[styles.wrap, { height }]} />;
  }

  return (
    <View style={[styles.wrap, { height }]}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
      >
        <Marker coordinate={PLANT_ORIGIN} title="UWC Batu Kawan" pinColor={colors.blue} />
        <Marker coordinate={dest} title="Destination" pinColor={colors.red} />
        <Polyline
          coordinates={route?.polyline?.length ? route.polyline : [PLANT_ORIGIN, dest]}
          strokeColor={colors.blue}
          strokeWidth={4}
        />
        {live && pos ? (
          <Marker
            coordinate={{ latitude: pos.latitude, longitude: pos.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            title="Truck"
          >
            <View style={[styles.truckRing, pos.stale && styles.truckRingStale]}>
              <View style={[styles.truckDot, pos.stale && styles.truckDotStale]} />
            </View>
          </Marker>
        ) : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 14, overflow: "hidden" },
  truckRing: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(61,170,53,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  truckRingStale: { backgroundColor: "rgba(154,165,196,0.25)" },
  truckDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.green,
    borderWidth: 2,
    borderColor: colors.white,
  },
  truckDotStale: { backgroundColor: colors.textFaint },
});
