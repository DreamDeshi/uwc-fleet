import React from "react";
import { StyleProp, StyleSheet, Text, View, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme";

// Shown in place of the Google map when no Google Maps API key is configured
// (e.g. sideloaded preview APKs without a key). react-native-maps' Android
// provider crashes the whole app if it mounts without a key in the manifest,
// so we render this lightweight stand-in instead of <MapView>. See lib/maps.ts.
export function MapPlaceholder({
  style,
  label = "Map preview unavailable",
}: {
  style?: StyleProp<ViewStyle>;
  label?: string;
}) {
  return (
    <View style={[styles.wrap, style]}>
      <Ionicons name="map-outline" size={36} color={colors.textFaint} />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.tintBlue,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  text: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 24,
  },
});
