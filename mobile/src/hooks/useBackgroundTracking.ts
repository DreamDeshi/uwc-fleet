import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as Location from "expo-location";
import { startBackgroundTracking, stopBackgroundTracking } from "../lib/backgroundLocation";

export type BgPermission = "unknown" | "granted" | "denied" | "unsupported";

export interface BackgroundTrackingState {
  // True once the OS-driven background task owns capture. When true the
  // foreground hook stands down (no double-capture); when false the driver is
  // on the foreground fallback.
  backgroundActive: boolean;
  permission: BgPermission;
}

// Manages the background-location lifecycle for one active trip. When the trip
// is in_progress AND the driver has consented, it secures the OS permissions in
// the required order (foreground → "Allow all the time" background) and starts
// the persistent background task. When the trip leaves in_progress (or consent
// is withdrawn) it stops the task.
//
// Crucially, it does NOT stop tracking on unmount — the whole point is that
// tracking survives the driver leaving the screen, backgrounding, or closing the
// app. The stop is driven by trip state, not by React lifecycle. `retryNonce`
// bumps to re-request a permission the driver previously declined.
export function useBackgroundTracking(
  tripId: string,
  active: boolean,
  consented: boolean,
  retryNonce = 0
): BackgroundTrackingState {
  const [backgroundActive, setBackgroundActive] = useState(false);
  const [permission, setPermission] = useState<BgPermission>(
    Platform.OS === "web" ? "unsupported" : "unknown"
  );

  useEffect(() => {
    if (Platform.OS === "web") {
      setPermission("unsupported");
      setBackgroundActive(false);
      return;
    }

    let cancelled = false;
    const desired = active && consented;

    (async () => {
      if (!desired) {
        // Trip not active / not consented → make sure nothing is left running.
        await stopBackgroundTracking();
        if (!cancelled) setBackgroundActive(false);
        return;
      }

      // Foreground first — background permission is impossible without it.
      let fg = (await Location.getForegroundPermissionsAsync()).status;
      if (fg !== "granted") fg = (await Location.requestForegroundPermissionsAsync()).status;
      if (cancelled) return;
      if (fg !== "granted") {
        setPermission("denied");
        setBackgroundActive(false); // foreground path can't run either — badge shows off
        return;
      }

      // Then "Always / Allow all the time". On Android 11+ the OS may route the
      // driver to Settings rather than show a dialog; the consent explainer
      // primed them for that.
      let bg = (await Location.getBackgroundPermissionsAsync()).status;
      if (bg !== "granted") bg = (await Location.requestBackgroundPermissionsAsync()).status;
      if (cancelled) return;

      if (bg === "granted") {
        await startBackgroundTracking(tripId);
        if (cancelled) return;
        setPermission("granted");
        setBackgroundActive(true);
      } else {
        // Background denied → fall back to the foreground path (unchanged).
        setPermission("denied");
        setBackgroundActive(false);
      }
    })();

    // No stop in cleanup: navigating away / backgrounding must NOT end tracking.
    return () => {
      cancelled = true;
    };
  }, [tripId, active, consented, retryNonce]);

  return { backgroundActive, permission };
}
