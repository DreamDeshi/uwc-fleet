import React from "react";
import { View, StyleSheet } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { useAuth } from "../context/AuthContext";
import { usePushNotificationListeners } from "../hooks/usePushNotifications";
import { LoadingState } from "../components/States";
import { colors } from "../theme";
import { AuthStack } from "./AuthStack";
import { DriverTabs } from "./DriverTabs";
import { RequestorStack } from "./RequestorStack";
import { AdminNavigator } from "../admin/navigation/AdminNavigator";

export function RootNavigator() {
  const { status, user } = useAuth();
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
        // One app, one login, role-routed: the in-app admin (Phase 1 — the
        // ported screens are live; the rest of the drawer lights up as
        // phases land). The web admin stays deployed and canonical until
        // the post-Phase-4 cutover.
        <AdminNavigator />
      )}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
});
