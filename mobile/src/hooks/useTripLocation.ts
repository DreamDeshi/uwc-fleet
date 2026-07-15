import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";
import { api } from "../services/api";
import {
  enqueueLocation,
  getQueuedLocations,
  getQueuedCount,
  removeLocations,
  QueuedPoint,
} from "../lib/locationQueue";
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
//   1. captures the phone's position every 30s (foreground only — a JS timer),
//   2. appends it to the durable offline queue,
//   3. flushes the queue to POST /locations whenever the network allows.
// On reconnect (NetInfo) or when the app returns to foreground, it flushes
// immediately so a backlog built up with no signal goes out right away.
// `retryNonce` — bump it (from the badge's "tap to enable") to re-request a
// permission that was previously denied without changing consent.
export function useTripLocation(
  tripId: string,
  enabled: boolean,
  consented: boolean,
  retryNonce = 0
): TripLocationState {
  const [status, setStatus] = useState<TrackingStatus>("idle");
  const [current, setCurrent] = useState<LatLng | null>(null);
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);

  // A lock so a slow flush triggered by the 30s tick can't overlap with one
  // triggered by a reconnect event (which would double-send the same points).
  const flushing = useRef(false);

  // Send every queued point to the server, then drop exactly what was accepted.
  // On any network error we keep the queue and try again on the next trigger.
  const flush = useRef(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const points = await getQueuedLocations();
      if (points.length > 0) {
        await api.post("/locations", { points });
        await removeLocations(points);
      }
      setQueued(await getQueuedCount());
    } catch {
      // offline or server error — leave the queue intact for the next attempt
      setQueued(await getQueuedCount());
    } finally {
      flushing.current = false;
    }
  });

  // Capture one GPS reading, queue it, then attempt a flush.
  const tick = useRef(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const point: QueuedPoint = {
        trip_id: tripId,
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        recorded_at: new Date(pos.timestamp).toISOString(),
      };
      setCurrent({ latitude: point.latitude, longitude: point.longitude });
      await enqueueLocation(point);
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
  }, [enabled, tripId, consented, retryNonce]);

  return { status, current, queued, online };
}
