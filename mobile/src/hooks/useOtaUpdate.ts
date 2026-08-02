// Foreground OTA check — the half expo-updates does not do for us.
//
// See lib/otaUpdatePolicy.ts for WHY the built-in automatic check never reaches
// a driver who does not force-quit. Short version: it runs once per process
// start, and even then it only downloads for the NEXT start. This hook checks
// on every qualifying foreground, downloads, and then STOPS — the restart is
// the driver's tap, never ours.
//
// ⚠ WHY WE NEVER RELOAD ON OUR OWN. Reloading tears down the JS runtime and
// every piece of unsaved in-memory state with it. On this app the foreground
// event we hang off is the SAME event that fires when the camera hands a POD
// photo back (expo-image-picker backgrounds the app to launch it) — so an
// auto-reload would land exactly on the driver returning with an unsent photo,
// a half-filled exception form, or an unsubmitted booking. The queued POD
// outbox is on disk and would survive; the capture in hand would not. A banner
// costs one tap and cannot eat someone's work.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Updates from "expo-updates";
import {
  isForegroundTransition,
  shouldCheckOnForeground,
  type OtaPhase,
} from "../lib/otaUpdatePolicy";

export interface OtaUpdateState {
  phase: OtaPhase;
  /** Apply the downloaded update. Only meaningful while phase === "ready". */
  restart: () => void;
}

export function useOtaUpdate(): OtaUpdateState {
  const [phase, setPhase] = useState<OtaPhase>("idle");
  // Refs, not state: the AppState listener is installed once and must read the
  // CURRENT values, not the ones captured when the effect first ran.
  const phaseRef = useRef<OtaPhase>("idle");
  const lastCheckAt = useRef<number | null>(null);
  const appState = useRef<string>(AppState.currentState ?? "active");

  const setBoth = useCallback((next: OtaPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // Disabled in Expo Go, in dev builds, and on web — `Updates.isEnabled` is
  // false wherever no update URL is baked in, and calling check/fetch there
  // throws rather than no-oping.
  const enabled = Updates.isEnabled && Platform.OS !== "web";

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const run = async () => {
      if (
        !shouldCheckOnForeground({
          phase: phaseRef.current,
          lastCheckAt: lastCheckAt.current,
          now: Date.now(),
        })
      ) {
        return;
      }
      setBoth("checking");
      try {
        const result = await Updates.checkForUpdateAsync();
        // Stamp the check on COMPLETION, not on entry: a check that took 30s on
        // a bad connection should not have its throttle window start before it
        // finished, or a burst of foregrounds queues behind it and all fire.
        lastCheckAt.current = Date.now();
        if (cancelled) return;
        if (!result.isAvailable) {
          setBoth("idle");
          return;
        }
        setBoth("downloading");
        await Updates.fetchUpdateAsync();
        if (cancelled) return;
        setBoth("ready");
      } catch {
        // Offline, DNS failure, expo.dev unreachable — all normal in a depot.
        // Stay silent: the driver cannot act on it and the next foreground
        // retries. The manual button in AppUpdatesCard still surfaces the real
        // error for anyone deliberately looking.
        lastCheckAt.current = Date.now();
        if (!cancelled) setBoth("error");
      }
    };

    // Check on mount too. This is a cold start, and it is what collapses the
    // "two cold launches" into one: the native flow would have downloaded this
    // update for the NEXT start, whereas finding it here offers the restart now.
    void run();

    const sub = AppState.addEventListener("change", (next) => {
      const previous = appState.current;
      appState.current = next;
      if (isForegroundTransition(previous, next)) void run();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [enabled, setBoth]);

  const restart = useCallback(() => {
    // Errors here are not actionable either — if the reload fails the app is
    // still running the old bundle, which is exactly where it was.
    void Updates.reloadAsync().catch(() => {});
  }, []);

  return { phase, restart };
}
