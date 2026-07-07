import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors } from "../theme";
import { formatDateTime } from "../lib/format";
import type { TimelineStep, TripEvent } from "../types";

const TERMINAL: TripEvent[] = ["rejected", "cancelled"];

const LABEL_KEY: Record<TripEvent, string> = {
  booked: "timeline.booked",
  assigned: "timeline.assigned",
  started: "timeline.started",
  stop_arrived: "timeline.stopArrived",
  stop_delivered: "timeline.stopDelivered",
  completed: "timeline.completed",
  rejected: "timeline.rejected",
  cancelled: "timeline.cancelled",
  assigned_external: "timeline.assignedExternal",
  rerouted: "timeline.rerouted",
};

/**
 * Adaptive status timeline shared by the requestor and driver detail screens.
 * Renders the milestone list from GET /trips/:id (.timeline) as a vertical
 * stepper: done = green ✓, current = blue dot, upcoming = greyed, terminal
 * (rejected/cancelled) = red ✕. Per-stop steps show "Stop N · Place".
 */
export function StatusTimeline({ steps }: { steps: TimelineStep[] }) {
  const { t } = useTranslation();
  if (!steps.length) return null;

  return (
    <View>
      {steps.map((step, i) => {
        const terminal = TERMINAL.includes(step.event);
        const done = step.state === "done";
        const current = step.state === "current";
        const upcoming = step.state === "upcoming";
        const dotColor = terminal ? colors.red : done ? colors.green : current ? colors.blue : "#c0cbdf";
        const textColor = terminal
          ? colors.red
          : done
            ? colors.green
            : current
              ? colors.blue
              : colors.textFaint;

        const base = t(LABEL_KEY[step.event]);
        const isStopStep = !!step.stopId && (step.event === "stop_arrived" || step.event === "stop_delivered");
        const label = isStopStep
          ? `${t("timeline.stopPrefix", { n: step.stopSequence })}${step.stopLabel ? ` · ${step.stopLabel}` : ""} — ${base}`
          : base;

        const sub = step.timestamp
          ? formatDateTime(step.timestamp)
          : upcoming
            ? t("timeline.pending")
            : "—";
        const isLast = i === steps.length - 1;

        return (
          <View key={`${step.event}-${step.stopId ?? ""}-${i}`} style={styles.row}>
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: dotColor }]}>
                {done ? (
                  <Ionicons name="checkmark" size={13} color={colors.white} />
                ) : terminal ? (
                  <Ionicons name="close" size={13} color={colors.white} />
                ) : current ? (
                  <View style={styles.inner} />
                ) : null}
              </View>
              {!isLast ? (
                <View style={[styles.line, { backgroundColor: done ? colors.green : "#e8edf5" }]} />
              ) : null}
            </View>
            <View style={{ flex: 1, paddingBottom: isLast ? 0 : 8 }}>
              <Text style={[styles.label, { color: textColor }]}>{label}</Text>
              <Text style={styles.sub}>
                {sub}
                {step.note ? ` · ${step.note}` : ""}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 14 },
  rail: { alignItems: "center" },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  inner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.white },
  line: { width: 2, flex: 1, minHeight: 22, marginTop: 2 },
  label: { fontSize: 14, fontWeight: "700", paddingTop: 4 },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
