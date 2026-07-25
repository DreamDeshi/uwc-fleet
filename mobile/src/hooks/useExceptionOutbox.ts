import { useCallback, useEffect } from "react";
import { AppState, Platform } from "react-native";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";
import { useQueryClient } from "@tanstack/react-query";
import { api, apiErrorCode, isNetworkError } from "../services/api";
import { reportExceptionForTrip, type ExceptionFull } from "../services/exceptions";
import { appendPhoto, UPLOAD_HEADERS } from "./queries";
import { getGpsConsent } from "../lib/gpsConsent";
import { toDurablePhotoUri, type PickedPhoto } from "../lib/photo";
import { uuidv4 } from "../lib/uuid";
import {
  enqueueExceptionReport,
  flushExceptionOutbox,
  noteDirectReport,
  type ExceptionOutboxApi,
  type ExceptionOutboxItem,
} from "../lib/exceptionOutbox";

// Wiring for the exception offline outbox + the driver "Report Exception" action.
// The report replays against the SAME endpoint the online flow uses; the server
// dedupes on client_occurrence_id, so a replay never creates a duplicate report.

/** One-shot ACTIVE-TRIP GPS: only with app-level consent AND foreground OS
 *  permission. Returns nulls (never throws) if unavailable — the server accepts
 *  a report without coordinates. No off-trip capture: callers only invoke this
 *  while the driver is reporting on an in-progress trip. */
async function captureActiveTripGps(): Promise<{ lat: number | null; lng: number | null; accuracyM: number | null }> {
  const none = { lat: null, lng: null, accuracyM: null };
  try {
    if ((await getGpsConsent()) !== "accepted") return none;
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return none;
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null };
  } catch {
    return none;
  }
}

export interface ReportExceptionArgs {
  tripId: string;
  category: string;
  reason: string;
  tripStopId?: string | null;
  photo: PickedPhoto;
}

/**
 * Report an exception. Captures active-trip GPS + a client capture timestamp
 * automatically (the driver cannot forge the SERVER receipt time — the server
 * always stamps its own). Tries the online endpoint first; on a NETWORK error it
 * queues to the durable outbox for automatic replay. Returns the created
 * exception when online, or null when queued offline.
 */
export function useReportException() {
  const qc = useQueryClient();
  return useCallback(
    async (args: ReportExceptionArgs): Promise<ExceptionFull | null> => {
      const gps = await captureActiveTripGps();
      const clientAt = new Date().toISOString(); // device time — server keeps its own receipt time
      const photo = await toDurablePhotoUri(args.photo); // survive a web reload if it queues
      const ids = { clientOccurrenceId: uuidv4(), clientActionId: uuidv4(), clientEvidenceId: uuidv4() };

      try {
        const exc = await reportExceptionForTrip(args.tripId, {
          category: args.category,
          reason: args.reason,
          tripStopId: args.tripStopId ?? null,
          photo,
          lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM,
          clientAt, capturedClientAt: clientAt,
          ...ids,
        });
        await noteDirectReport(ids.clientOccurrenceId);
        qc.invalidateQueries({ queryKey: ["exception", args.tripId] });
        qc.invalidateQueries({ queryKey: ["exceptions", "open"] });
        return exc;
      } catch (err) {
        if (!isNetworkError(err)) throw err; // a server rejection is a real error to surface
        // Offline — queue for replay. Same occurrence id, so the eventual sync
        // is idempotent (no duplicate report).
        await enqueueExceptionReport({
          tripId: args.tripId,
          category: args.category,
          reason: args.reason,
          tripStopId: args.tripStopId ?? null,
          photo: { uri: photo.uri, name: photo.name, type: photo.type },
          lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM,
          clientAt,
          ...ids,
        });
        return null;
      }
    },
    [qc]
  );
}

// The real API the pure replay core runs against — one POST to the report
// endpoint, idempotent on client_occurrence_id.
const realApi: ExceptionOutboxApi = {
  async report(item: ExceptionOutboxItem) {
    const form = new FormData();
    form.append("category", item.category);
    form.append("reason", item.reason);
    if (item.tripStopId) form.append("trip_stop_id", item.tripStopId);
    form.append("client_occurrence_id", item.clientOccurrenceId);
    form.append("client_action_id", item.clientActionId);
    form.append("client_evidence_id", item.clientEvidenceId);
    if (item.lat != null) form.append("lat", String(item.lat));
    if (item.lng != null) form.append("lng", String(item.lng));
    if (item.accuracyM != null) form.append("accuracy_m", String(item.accuracyM));
    form.append("client_at", item.clientAt);
    form.append("captured_client_at", item.clientAt);
    await appendPhoto(form, "photo", item.photo);
    await api.post(`/trips/${item.tripId}/exception`, form, { headers: UPLOAD_HEADERS, timeout: 60_000 });
  },
  errorCode: apiErrorCode,
  isNetworkError,
};

const RETRY_INTERVAL_MS = 45_000;

/** Mount ONCE on the driver surface: flush the exception outbox on mount,
 *  reconnect, foreground and a periodic tick. */
export function useExceptionOutboxFlush(): void {
  const qc = useQueryClient();
  const run = useCallback(async () => {
    try {
      const res = await flushExceptionOutbox(realApi);
      if (res.synced > 0 || res.dropped > 0) {
        qc.invalidateQueries({ queryKey: ["exception"] });
        qc.invalidateQueries({ queryKey: ["exceptions", "open"] });
      }
    } catch {
      /* never crash the UI — the next trigger retries */
    }
  }, [qc]);

  useEffect(() => {
    run();
    let removeNet: () => void;
    if (Platform.OS === "web") {
      const onOnline = () => run();
      window.addEventListener("online", onOnline);
      removeNet = () => window.removeEventListener("online", onOnline);
    } else {
      removeNet = NetInfo.addEventListener((s) => s.isConnected && run());
    }
    const appSub = AppState.addEventListener("change", (s) => s === "active" && run());
    const interval = setInterval(run, RETRY_INTERVAL_MS);
    return () => {
      removeNet();
      appSub.remove();
      clearInterval(interval);
    };
  }, [run]);
}
