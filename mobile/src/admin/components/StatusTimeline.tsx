// Adaptive status timeline — RN port of admin/src/components/StatusTimeline.
// Renders the milestone list from GET /trips/:id .timeline as a vertical
// stepper: done = green, current = blue + bold, upcoming = greyed; terminal
// (rejected/cancelled) = red. Labels via i18n (admin.timeline.*).
import React from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, font } from "../theme";
import { formatDateTime } from "../lib/format";
import type { TimelineStep, TripEvent } from "../types";

const TERMINAL: TripEvent[] = ["rejected", "cancelled"];

function dotColor(step: TimelineStep): string {
  if (TERMINAL.includes(step.event)) return colors.red;
  if (step.state === "done") return colors.green;
  if (step.state === "current") return colors.blue;
  return colors.border;
}

export function StatusTimeline({ steps }: { steps: TimelineStep[] }) {
  const { t } = useTranslation();
  if (!steps.length) return null;

  const stepLabel = (step: TimelineStep): string => {
    const base = t(`admin.timeline.${step.event}`, { defaultValue: step.event });
    if (step.stopId && (step.event === "stop_arrived" || step.event === "stop_delivered")) {
      const place = step.stopLabel ? ` · ${step.stopLabel}` : "";
      return `${t("admin.timeline.stop", { n: step.stopSequence })}${place} — ${base}`;
    }
    return base;
  };

  return (
    <View style={{ marginBottom: 18 }}>
      <Text style={{ fontSize: font.sm, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, color: colors.textMuted, marginBottom: 10 }}>
        {t("admin.timeline.title")}
      </Text>
      <View>
        {steps.map((step, i) => {
          const color = dotColor(step);
          const isLast = i === steps.length - 1;
          const upcoming = step.state === "upcoming";
          return (
            <View key={`${step.event}-${step.stopId ?? ""}-${i}`} style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ alignItems: "center" }}>
                <View
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: 7,
                    backgroundColor: step.state === "upcoming" ? colors.card : color,
                    borderWidth: 2.5,
                    borderColor: color,
                    marginTop: 2,
                  }}
                />
                {!isLast && <View style={{ width: 2, flex: 1, minHeight: 22, backgroundColor: colors.border, marginTop: 2 }} />}
              </View>
              <View style={{ paddingBottom: isLast ? 0 : 14, flex: 1 }}>
                <Text style={{ fontSize: font.md, fontWeight: step.state === "current" ? "800" : "600", color: upcoming ? colors.textFaint : colors.text }}>
                  {stepLabel(step)}
                </Text>
                <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 1 }}>
                  {step.timestamp ? formatDateTime(step.timestamp) : upcoming ? t("admin.timeline.pending") : "—"}
                  {step.note ? ` · ${step.note}` : ""}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
