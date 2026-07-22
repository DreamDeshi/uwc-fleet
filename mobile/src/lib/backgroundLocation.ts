import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { enqueueLocation } from "./locationQueue";
import { flushQueuedLocations } from "./locationFlush";
import { backgroundTrackingAction } from "./backgroundTracking";

// Continuous, OS-driven GPS capture that survives the app being closed or the
// phone being locked (the foreground setInterval in useTripLocation only ticks
// while the JS runtime is alive). The moment a driver's trip is in_progress the
// OS keeps handing this task location batches until we stop it at trip-end.
//
// This module is imported from index.js so defineTask() runs at startup —
// BEFORE the OS can ever fire the task in a headless launch.

export const BACKGROUND_LOCATION_TASK = "uwc.backgroundLocation";

// The trip the task is currently capturing for. Persisted so the HEADLESS task
// (which has no React state) knows which trip a fix belongs to, and so a leaked
// task with no trip can detect it should stop.
const BG_TRIP_KEY = "uwc.bgTrip";

// Background location is native-only. On web the task APIs don't exist, so every
// entry point below no-ops and the driver falls back to the foreground path.
const SUPPORTED = Platform.OS === "ios" || Platform.OS === "android";

interface LocationTaskPayload {
  locations?: Location.LocationObject[];
}

// ── The task itself — runs OUTSIDE React, possibly with the app killed ────────
if (SUPPORTED) {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error) return;
    const tripId = await AsyncStorage.getItem(BG_TRIP_KEY);
    if (!tripId) {
      // No trip should be tracked but the task still fired — self-heal so we
      // can never keep draining GPS for a trip that ended.
      await stopBackgroundTracking();
      return;
    }
    const locations = (data as LocationTaskPayload)?.locations ?? [];
    for (const loc of locations) {
      await enqueueLocation({
        trip_id: tripId,
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        recorded_at: new Date(loc.timestamp).toISOString(),
      });
    }
    // Flush through the SAME durable-queue path as the foreground hook, loading
    // the token from storage first (headless has no live AuthContext).
    const { inactiveTripIds } = await flushQueuedLocations(true);
    // Server-side self-heal: the tracked trip is no longer active (e.g. an admin
    // cancelled it while the app was closed) → stop, even fully backgrounded.
    if (inactiveTripIds.includes(tripId)) {
      await stopBackgroundTracking();
    }
  });
}

async function hasStarted(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  } catch {
    return false;
  }
}

// Start (or re-point) continuous background tracking for `tripId`. Idempotent:
// if it's already running for this trip it's a no-op; if it's running for a
// DIFFERENT trip it restarts cleanly. Assumes the caller has already secured the
// "Allow all the time" background permission.
export async function startBackgroundTracking(tripId: string): Promise<void> {
  if (!SUPPORTED) return;
  const running = (await hasStarted()) ? await AsyncStorage.getItem(BG_TRIP_KEY) : null;
  const action = backgroundTrackingAction(tripId, running);
  if (action === "noop") return;
  if (action === "restart") {
    try {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    } catch {
      /* not running — fine */
    }
  }
  await AsyncStorage.setItem(BG_TRIP_KEY, tripId);
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 30_000, // ~a fix every 30s, matching the old foreground cadence
    distanceInterval: 25, // ...or every 25m, whichever comes first
    deferredUpdatesInterval: 30_000,
    pausesUpdatesAutomatically: false, // iOS: don't let the OS pause us when still
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true, // iOS blue status bar while tracking
    // Android REQUIRES a persistent foreground-service notification for
    // background location — this is the non-dismissable "tracking is on" chip.
    foregroundService: {
      notificationTitle: "UWC Trucking — tracking active",
      notificationBody: "Sharing your truck's location with dispatch during this delivery.",
      notificationColor: "#003087",
    },
  });
}

// Stop tracking and clear the tracked trip. Idempotent and safe to call when
// nothing is running (trip-end, un-consent, or the task's own self-heal).
export async function stopBackgroundTracking(): Promise<void> {
  await AsyncStorage.removeItem(BG_TRIP_KEY);
  if (!SUPPORTED) return;
  if (await hasStarted()) {
    try {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    } catch {
      /* already stopped */
    }
  }
}

export async function isBackgroundTrackingActive(): Promise<boolean> {
  return SUPPORTED ? hasStarted() : false;
}
