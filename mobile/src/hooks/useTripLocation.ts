import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";
import { enqueueLocation, getQueuedCount, QueuedPoint } from "../lib/locationQueue";
import { flushQueuedLocations } from "../lib/locationFlush";
import { LatLng } from "../lib/geo";
import { trackingGate } from "../lib/gpsTracking";

// How often the phone captures and posts its position during an active trip.
const INTERVAL_MS = 30_000;

export type TrackingStatus = "idle" | "needs_consent" | "requesting" | "tracking" | "denied";

export interface TripLocationState {
  status: TrackingStatus;
  current: LatLng | null; // latest fix — drives the "you are here" dot
  queued: number; // unsent points sitting in the offline buffer
  online: boolean;
}

// Drives GPS tracking for one active trip. Only ever captures when the trip is
// active (`enabled`) AND the driver has consented (`consented`) — the privacy
// rule (see lib/gpsTracking). While active it:
//   1. captures the phone's position every 30s (a JS timer — foreground only),
//   2. appends it to the durable offline queue,
//   3. flushes the queue to POST /locations whenever the network allows.
// On reconnect (NetInfo) or when the app returns to foreground, it flushes
// immediately so a backlog built up with no signal goes out right away.
//
// `backgroundOwnsCapture` — when the OS-driven background task (useBackground-
// Tracking) is running, IT owns capture (foreground AND background). This hook
// then stands down its own enqueue so the same fix isn't posted twice; it still
// refreshes the "you are here" dot and the queued/online badge from the shared
// queue, so the on-screen UI stays live.
//
// `retryNonce` — bump it (from the badge's "tap to enable") to re-request a
// permission that was previously denied without changing consent.
export function useTripLocation(
  tripId: string,
  enabled: boolean,
  consented: boolean,
  retryNonce = 0,
  backgroundOwnsCapture = false
): TripLocationState {
  const [status, setStatus] = useState<TrackingStatus>("idle");
  const [current, setCurrent] = useState<LatLng | null>(null);
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);

  // Live mirror of backgroundOwnsCapture for the tick closures (which are
  // created once via useRef but must react to it changing).
  const bgOwns = useRef(backgroundOwnsCapture);
  bgOwns.current = backgroundOwnsCapture;

  // Send every queued point to the server, then drop exactly what was accepted.
  // Shared with the background task so the offline/batching behaviour is identical.
  const flush = useRef(async () => {
    const res = await flushQueuedLocations();
    setOnline(true);
    setQueued(res.count);
  });

  // Capture one GPS reading, queue it (unless the background task already is),
  // then attempt a flush.
  const tick = useRef(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setCurrent({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      // When the background task owns capture, DON'T enqueue here — it already
      // did, and a second point would double-post. We still update the dot above.
      if (!bgOwns.current) {
        const point: QueuedPoint = {
          trip_id: tripId,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          recorded_at: new Date(pos.timestamp).toISOString(),
        };
        await enqueueLocation(point);
      }
      setQueued(await getQueuedCount());
    } catch {
      // a single failed GPS read is fine — we just try again next interval
    }
    await flush.current();
  });

  useEffect(() => {
    const gate = trackingGate(enabled, consented);
    if (gate === "idle") {
      setStatus("idle");
      return;
    }
    if (gate === "needs_consent") {
      // Trip is active but the driver hasn't agreed yet — do NOT request the OS
      // permission or capture anything. The screen shows the consent explainer.
      setStatus("needs_consent");
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    (async () => {
      setStatus("requesting");
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (perm !== "granted") {
        setStatus("denied");
        return;
      }
      setStatus("tracking");
      setQueued(await getQueuedCount());
      await tick.current(); // capture immediately, don't wait 30s for the first fix
      interval = setInterval(() => tick.current(), INTERVAL_MS);
    })();

    // Flush the backlog the moment the network comes back.
    const netSub = NetInfo.addEventListener((state) => {
      const isOnline = Boolean(state.isConnected);
      setOnline(isOnline);
      if (isOnline) flush.current();
    });

    // Also flush when the app returns to the foreground.
    const appSub = AppState.addEventListener("change", (s) => {
      if (s === "active") flush.current();
    });

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      netSub();
      appSub.remove();
    };
  }, [enabled, tripId, consented, retryNonce, backgroundOwnsCapture]);

  return { status, current, queued, online };
}
