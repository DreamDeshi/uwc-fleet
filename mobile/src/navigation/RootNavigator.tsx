import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { usePushNotificationListeners } from "../hooks/usePushNotifications";
import { LoadingState } from "../components/States";
import { Button } from "../components/Button";
import { colors } from "../theme";
import { AuthStack } from "./AuthStack";
import { DriverTabs } from "./DriverTabs";
import { RequestorStack } from "./RequestorStack";

export function RootNavigator() {
  const { status, user, logout } = useAuth();
  const { t } = useTranslation();
  usePushNotificationListeners();

  return (
    <NavigationContainer>
      {status === "loading" ? (
        <View style={styles.fill}>
          <LoadingState />
        </View>
      ) : status === "guest" || !user ? (
        <AuthStack />
      ) : user.role === "driver" ? (
        <DriverTabs />
      ) : user.role === "requestor" ? (
        <RequestorStack />
      ) : (
        // Admin uses the web dashboard (Phase 4) — show a friendly note here.
        <View style={styles.adminFill}>
          <Text style={styles.adminTitle}>{t("admin.webOnlyTitle")}</Text>
          <Text style={styles.adminBody}>{t("admin.webOnlyBody")}</Text>
          <Button title={t("profile.logout")} onPress={logout} variant="outline" style={{ marginTop: 20 }} />
        </View>
      )}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  adminFill: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 32 },
  adminTitle: { fontSize: 22, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  adminBody: { fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 20 },
});
