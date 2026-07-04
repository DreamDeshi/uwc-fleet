import { useCallback, useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, apiErrorCode, isNetworkError } from "../services/api";
import { useToast } from "../components/Toast";
import { appendPhoto, UPLOAD_HEADERS } from "./queries";
import {
  flushPodOutbox,
  getPodOutbox,
  subscribePodOutbox,
  type PodOutboxApi,
  type PodOutboxItem,
} from "../lib/podOutbox";

// Wiring for the POD offline outbox: the real API calls the pure replay core
// runs against, plus the triggers that fire a flush. Mirrors useTripLocation.

// The outbox replays against the SAME endpoints the online flow uses — no
// server change: POD upload (overwrites the stop's publicId), the idempotent
// K2 flag PATCH, and the write-once delivered confirm.
const realApi: PodOutboxApi = {
  async markArrived(item: PodOutboxItem) {
    await api.patch(`/trips/${item.tripId}/status`, { action: "arrived", stop_id: item.stopId });
  },
  async uploadPod(item: PodOutboxItem) {
    const form = new FormData();
    await appendPhoto(form, "photo", item.photo!);
    await api.post(`/trips/${item.tripId}/stops/${item.stopId}/pod`, form, {
      headers: UPLOAD_HEADERS,
      timeout: 60_000,
    });
  },
  async ackK2(item: PodOutboxItem) {
    await api.patch(`/trips/${item.tripId}/stops/${item.stopId}/docs`, { k2_form_ack: true });
  },
  async confirmDelivered(item: PodOutboxItem) {
    await api.patch(`/trips/${item.tripId}/status`, { action: "delivered", stop_id: item.stopId });
  },
  errorCode: apiErrorCode,
  isNetworkError,
};

// How often to re-try while items are queued. Deliberately longer than the
// GPS queue's 30s — each attempt can carry a photo upload.
const RETRY_INTERVAL_MS = 45_000;

/** Live view of the queued items (drives the per-stop "waiting for signal" UI). */
export function usePodOutboxItems(): PodOutboxItem[] {
  const [items, setItems] = useState<PodOutboxItem[]>([]);
  useEffect(() => {
    let mounted = true;
    const load = () => getPodOutbox().then((i) => mounted && setItems(i));
    load();
    const unsub = subscribePodOutbox(load);
    return () => {
      mounted = false;
      unsub();
    };
  }, []);
  return items;
}

/**
 * Mount ONCE on the driver surface (DriverTabs). Flushes the outbox on:
 * mount, connectivity coming back (web: the browser 'online' event — NetInfo
 * doesn't fire reliably on react-native-web; native: NetInfo), app
 * foreground, and a periodic tick while items are queued. Successful items
 * invalidate the trip queries so every screen catches up, and the driver gets
 * a "recorded" toast for deliveries that completed in the background.
 */
export function usePodOutboxFlush(): void {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const items = usePodOutboxItems();

  const run = useCallback(async () => {
    try {
      const res = await flushPodOutbox(realApi);
      if (res.synced > 0) {
        qc.invalidateQueries({ queryKey: ["trips"] });
        qc.invalidateQueries({ queryKey: ["trip"] }); // prefix → every trip detail
        qc.invalidateQueries({ queryKey: ["incentives", "mine"] });
        toast(t("trip.outboxSynced", { count: res.synced }), "success");
      }
      if (res.dropped > 0) {
        // Rare: the item can never complete (trip reassigned/removed, or a
        // persistent server error). The queries above resync the screens to
        // server truth; tell the driver so it isn't a silent disappearance.
        qc.invalidateQueries({ queryKey: ["trips"] });
        qc.invalidateQueries({ queryKey: ["trip"] });
        toast(t("trip.outboxDropped", { count: res.dropped }), "error");
      }
    } catch {
      // Never let a background flush crash the UI — next trigger retries.
    }
  }, [qc, toast, t]);

  useEffect(() => {
    run(); // catch up on anything queued before the app was killed/reloaded

    // Reconnect trigger — web-compatible by construction (requirement:
    // the trial runs in browsers, where NetInfo's events are unreliable).
    let removeNet: () => void;
    if (Platform.OS === "web") {
      const onOnline = () => run();
      window.addEventListener("online", onOnline);
      removeNet = () => window.removeEventListener("online", onOnline);
    } else {
      removeNet = NetInfo.addEventListener((state) => {
        if (state.isConnected) run();
      });
    }

    const appSub = AppState.addEventListener("change", (s) => {
      if (s === "active") run();
    });

    return () => {
      removeNet();
      appSub.remove();
    };
  }, [run]);

  // Periodic retry only while something is actually queued.
  useEffect(() => {
    if (items.length === 0) return;
    const interval = setInterval(run, RETRY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [items.length > 0, run]); // eslint-disable-line react-hooks/exhaustive-deps
}
