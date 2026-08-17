import React from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { useOutdoor } from "../context/OutdoorContext";
import { colors, radius } from "../theme";

/**
 * Outdoor mode, offered in Profile beside the language picker.
 *
 * ⚠ DRIVERS ONLY. The requestor and admin read this app at a desk, and the
 * override deliberately lives at the component rather than the token, so
 * showing them a switch would promise a change most of their screens would not
 * make. The role check is here rather than at the call site because Profile is
 * shared by driver and requestor.
 *
 * The copy says "this phone", not "your account", because it is a DEVICE
 * preference and a driver handing the handset over should be able to predict
 * what the next man gets.
 */
export function OutdoorModeRow({ style }: { style?: object }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { outdoorOn, setOutdoor } = useOutdoor();

  if (user?.role !== "driver") return null;

  return (
    <View style={[styles.card, style]}>
      <View style={styles.row}>
        <Ionicons name="sunny" size={20} color={colors.blue} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.label}>{t("outdoor.title")}</Text>
          <Text style={styles.sub}>{outdoorOn ? t("outdoor.on") : t("outdoor.off")}</Text>
        </View>
        <Switch
          value={outdoorOn}
          onValueChange={setOutdoor}
          trackColor={{ true: colors.blue, false: colors.border }}
          accessibilityLabel={t("outdoor.title")}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  label: { fontSize: 15, fontWeight: "700", color: colors.navy },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2, lineHeight: 18 },
});
