import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { colors, radius } from "../theme";

// Yellow rounded badge with a blue truck — the UWC mark from the prototype.
export function Logo({ size = 44, showText = true }: { size?: number; showText?: boolean }) {
  return (
    <View style={styles.row}>
      <View style={[styles.badge, { width: size, height: size, borderRadius: radius.md }]}>
        <MaterialCommunityIcons name="truck" size={size * 0.55} color={colors.blue} />
      </View>
      {showText ? (
        <View style={{ marginLeft: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline" }}>
            <Text style={styles.uwc}>UWC</Text>
            <Text style={styles.trucking}> TRUCKING</Text>
          </View>
          <Text style={styles.tagline}>Fleet Management Portal</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  badge: { backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  uwc: { color: colors.yellow, fontSize: 20, fontWeight: "800", letterSpacing: -0.5 },
  trucking: { color: colors.white, fontSize: 20, fontWeight: "700" },
  tagline: { color: "rgba(255,255,255,0.6)", fontSize: 12, fontWeight: "500", letterSpacing: 0.5 },
});
