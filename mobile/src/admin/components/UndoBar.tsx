// Undo grace window for the destructive dispatch actions (cancel / unassign /
// abort). These are money/ops-path and irreversible once they hit the server,
// so instead of firing on confirm we DEFER the mutation for a few seconds and
// show an "Undo" bar. Undo drops the action entirely; letting it run commits it.
//
// The timer MUST live here at the screen level, never inside MonitorPanel: that
// panel unmounts the instant its action closes the trip detail (onDone), which
// would kill any timer it owned. This hook is mounted by TripsScreen, which
// stays mounted, so the countdown survives the panel closing.
//
// Correctness notes (this is the money path):
//  - Only one action is pending at a time. Scheduling a second commits the
//    first immediately (it was already confirmed) before replacing it.
//  - If the screen unmounts mid-countdown (admin switches tabs), the pending
//    action is flushed — a confirmed action is never silently dropped.
//  - mutateAsync fns are read through a ref so a timer/unmount callback can
//    never fire a stale react-query closure.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAbortTrip, useCancelTrip, useUnassignTrip } from "../hooks/queries";
import { apiErrorMessage } from "../services/api";
import { colors, font, radius } from "../theme";

export type UndoActionType = "cancel" | "unassign" | "abort";

export interface UndoableAction {
  type: UndoActionType;
  tripId: string;
  ticket: string;
}

// How long the admin has to undo. Long enough to catch a misclick, short enough
// that the board isn't left in a limbo state.
export const UNDO_WINDOW_MS = 6000;

export interface UndoController {
  pending: UndoableAction | null;
  remaining: number;
  error: { action: UndoableAction; message: string } | null;
  schedule: (action: UndoableAction) => void;
  undo: () => void;
  dismissError: () => void;
}

export function useUndoableAction(): UndoController {
  const cancel = useCancelTrip();
  const unassign = useUnassignTrip();
  const abort = useAbortTrip();

  // Latest mutateAsync fns, read by timer/unmount callbacks (never a stale closure).
  const runnersRef = useRef({ cancel, unassign, abort });
  runnersRef.current = { cancel, unassign, abort };

  const [pending, setPending] = useState<UndoableAction | null>(null);
  const [remaining, setRemaining] = useState(UNDO_WINDOW_MS);
  const [error, setError] = useState<{ action: UndoableAction; message: string } | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef = useRef<UndoableAction | null>(null);

  const stopTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    timerRef.current = null;
    intervalRef.current = null;
  }, []);

  const runAction = useCallback((a: UndoableAction): Promise<unknown> => {
    const r = runnersRef.current;
    if (a.type === "cancel") return r.cancel.mutateAsync(a.tripId);
    if (a.type === "unassign") return r.unassign.mutateAsync({ id: a.tripId });
    return r.abort.mutateAsync({ id: a.tripId });
  }, []);

  // Commit the pending action NOW (timer expiry, or flushing to make room for a
  // newly-scheduled one). Errors surface in the bar rather than vanishing.
  const commit = useCallback(
    (a: UndoableAction) => {
      stopTimers();
      pendingRef.current = null;
      setPending(null);
      runAction(a).catch((e) => setError({ action: a, message: apiErrorMessage(e) }));
    },
    [runAction, stopTimers]
  );

  const schedule = useCallback(
    (action: UndoableAction) => {
      setError(null);
      // Flush any already-confirmed action before taking its place.
      if (pendingRef.current) commit(pendingRef.current);
      stopTimers();
      pendingRef.current = action;
      setPending(action);
      setRemaining(UNDO_WINDOW_MS);
      const deadline = Date.now() + UNDO_WINDOW_MS;
      intervalRef.current = setInterval(() => setRemaining(Math.max(0, deadline - Date.now())), 200);
      timerRef.current = setTimeout(() => commit(action), UNDO_WINDOW_MS);
    },
    [commit, stopTimers]
  );

  const undo = useCallback(() => {
    stopTimers();
    pendingRef.current = null;
    setPending(null);
    setError(null);
  }, [stopTimers]);

  const dismissError = useCallback(() => setError(null), []);

  // Flush a confirmed-but-not-yet-committed action if the screen unmounts.
  useEffect(
    () => () => {
      stopTimers();
      if (pendingRef.current) runAction(pendingRef.current).catch(() => {});
    },
    [runAction, stopTimers]
  );

  return { pending, remaining, error, schedule, undo, dismissError };
}

// ── The floating bar itself ───────────────────────────────────────────────
export function UndoBar({ controller }: { controller: UndoController }) {
  const { t } = useTranslation();
  const { pending, remaining, error } = controller;

  if (error) {
    return (
      <View style={[barBase, { borderColor: colors.red, backgroundColor: colors.redTint }]}>
        <Ionicons name="alert-circle" size={18} color={colors.red} />
        <Text style={{ flex: 1, fontSize: font.sm, fontWeight: "600", color: colors.red }} numberOfLines={2}>
          {t(`admin.trips.undo_${error.action.type}_failed`, { ticket: error.action.ticket, defaultValue: error.message })}
        </Text>
        <Pressable onPress={controller.dismissError} hitSlop={8}>
          <Text style={{ fontSize: font.sm, fontWeight: "800", color: colors.red }}>{t("common.dismiss")}</Text>
        </Pressable>
      </View>
    );
  }

  if (!pending) return null;
  const secs = Math.ceil(remaining / 1000);
  const pct = Math.max(0, Math.min(100, (remaining / UNDO_WINDOW_MS) * 100));

  return (
    <View style={[barBase, { borderColor: colors.border, backgroundColor: "#1f2937" }]}>
      <Ionicons name="time-outline" size={18} color="#fff" />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: font.sm, fontWeight: "700", color: "#fff" }} numberOfLines={1}>
          {t(`admin.trips.undo_${pending.type}_pending`, { ticket: pending.ticket })}
        </Text>
        <View style={{ height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.2)", marginTop: 6, overflow: "hidden" }}>
          <View style={{ height: "100%", width: `${pct}%`, backgroundColor: colors.yellow }} />
        </View>
      </View>
      <Pressable
        onPress={controller.undo}
        style={{ flexDirection: "row", alignItems: "center", gap: 5, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: colors.yellow }}
      >
        <Ionicons name="arrow-undo" size={14} color={colors.text} />
        <Text style={{ fontSize: font.sm, fontWeight: "800", color: colors.text }}>
          {t("admin.trips.undo")} · {secs}
        </Text>
      </Pressable>
    </View>
  );
}

const barBase = {
  position: "absolute" as const,
  left: 16,
  right: 16,
  bottom: 20,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 12,
  borderWidth: 1,
  borderRadius: radius.md,
  paddingVertical: 12,
  paddingHorizontal: 14,
  shadowColor: "#000",
  shadowOpacity: 0.2,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
};
