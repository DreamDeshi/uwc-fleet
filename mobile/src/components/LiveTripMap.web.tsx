import React from "react";
import { StyleSheet } from "react-native";
import { MapPlaceholder } from "./MapPlaceholder";

// Web fallback for the trip-tracking overview map. See ActiveTripMap.web.tsx —
// react-native-maps cannot bundle for web, so the browser build renders a
// placeholder while native keeps the real map (LiveTripMap.tsx). The prop
// signature mirrors the native component so callers are platform-agnostic.
export function LiveTripMap({
  height = 200,
}: {
  tripId: string;
  destZone?: string | null;
  live?: boolean;
  height?: number;
}) {
  return (
    <MapPlaceholder
      style={[styles.wrap, { height }]}
      label="Live map is available in the mobile app"
    />
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 14, overflow: "hidden" },
});
