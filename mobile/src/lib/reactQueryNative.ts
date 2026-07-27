// React Query's documented React Native setup — this app never had it, so RQ
// had no connectivity or foreground signal on native: `refetchOnReconnect`
// (default true) could never fire because nothing ever told the onlineManager
// about NetInfo, and an errored query stayed errored until its screen
// remounted. Part of the cold-reopen fix (27 Jul 2026).
//
// NATIVE-ONLY by design: on web the browser's built-in online/visibility
// events already drive RQ, and the trial-proven web behavior must not change.
import { AppState, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { focusManager, onlineManager } from "@tanstack/react-query";

export function wireReactQueryNative(): void {
  if (Platform.OS === "web") return;

  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      // Only a definite false is offline. isConnected starts as null on a cold
      // Android start — treating that as offline would pause every first fetch.
      setOnline(state.isConnected !== false);
    })
  );

  AppState.addEventListener("change", (status) => {
    focusManager.setFocused(status === "active");
  });
}
