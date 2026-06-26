import React from "react";
import { StyleSheet } from "react-native";
import { MapPlaceholder } from "./MapPlaceholder";

type LatLng = { latitude: number; longitude: number };

// Web fallback for the active-trip hero map. react-native-maps relies on the
// native Google/Apple map SDKs and cannot bundle for web, so the browser build
// shows a placeholder. Native (iOS/Android) keeps the real map via
// ActiveTripMap.tsx — Metro resolves the .web file only for the web platform.
export function ActiveTripMap(_props: {
  region?: any;
  dest?: LatLng;
  destLabel?: string;
  polyline?: LatLng[] | null;
  current?: LatLng | null;
}) {
  return (
    <MapPlaceholder
      style={StyleSheet.absoluteFill}
      label="Live map is available in the mobile app"
    />
  );
}
