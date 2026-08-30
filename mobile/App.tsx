import "react-native-gesture-handler";
import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";

import "./src/i18n"; // initialise i18next before any screen renders
import { queryClient } from "./src/lib/queryClient";
import { AuthProvider } from "./src/context/AuthContext";
import { ToastProvider } from "./src/components/Toast";
import { OutdoorProvider } from "./src/context/OutdoorContext";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { ReconnectingBanner } from "./src/components/ReconnectingBanner";
import { UpdateReadyBanner } from "./src/components/UpdateReadyBanner";
import { installWebFocusRing } from "./src/lib/webFocusRing";
import { installWebScrollbars } from "./src/lib/webScrollbars";
import { wireReactQueryNative } from "./src/lib/reactQueryNative";
import { installGlobalErrorReporting } from "./src/lib/errorReporting";

export default function App() {
  // Keyboard-only (:focus-visible) navy focus ring on web; no-op on native.
  // NetInfo/AppState → react-query wiring on native; no-op on web.
  // Global error reporting → POST /client-errors (owner ask, 27 Jul).
  React.useEffect(() => {
    installWebFocusRing();
    installWebScrollbars();
    wireReactQueryNative();
    installGlobalErrorReporting();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <OutdoorProvider>
            <ToastProvider>
              <StatusBar style="light" />
              <RootNavigator />
              <ReconnectingBanner />
              {/* Foreground OTA check + one-tap restart. Mounted app-wide so
                  every role sees it, and outside the navigator so a restart
                  offer survives screen changes. */}
              <UpdateReadyBanner />
            </ToastProvider>
            </OutdoorProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
