import { colors } from "@/theme";
import { formatDateTime } from "@/lib/format";
import type { TimelineStep, TripEvent } from "@/types";

// Display label per milestone. Stop-scoped events get a "Stop N · Place" prefix
// from the step itself, so these are the bare verbs.
const EVENT_LABEL: Record<TripEvent, string> = {
  booked: "Booked",
  assigned: "Assigned",
  started: "En route",
  stop_arrived: "Arrived",
  stop_delivered: "Delivered",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  assigned_external: "Assigned to forwarder",
  rerouted: "Rerouted",
};

const TERMINAL: TripEvent[] = ["rejected", "cancelled"];

function dotColor(step: TimelineStep): string {
  if (TERMINAL.includes(step.event)) return colors.red;
  if (step.state === "done") return colors.green;
  if (step.state === "current") return colors.blue;
  return colors.border;
}

function stepLabel(step: TimelineStep): string {
  const base = EVENT_LABEL[step.event];
  if (step.stopId && (step.event === "stop_arrived" || step.event === "stop_delivered")) {
    const place = step.stopLabel ? ` · ${step.stopLabel}` : "";
    return `Stop ${step.stopSequence}${place} — ${base}`;
  }
  return base;
}

/**
 * Adaptive status timeline for a trip. Renders the milestone list returned by
 * the API (GET /trips/:id .timeline) as a vertical stepper: done = green,
 * current = blue + bold, upcoming = greyed; terminal (rejected/cancelled) = red.
 */
export function StatusTimeline({ steps }: { steps: TimelineStep[] }) {
  if (!steps.length) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: colors.textMuted,
          marginBottom: 10,
        }}
      >
        Status timeline
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {steps.map((step, i) => {
          const color = dotColor(step);
          const isLast = i === steps.length - 1;
          const upcoming = step.state === "upcoming";
          return (
            <div key={`${step.event}-${step.stopId ?? ""}-${i}`} style={{ display: "flex", gap: 12 }}>
              {/* Rail: dot + connector line */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: "50%",
                    background: step.state === "upcoming" ? colors.card : color,
                    border: `2.5px solid ${color}`,
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                />
                {!isLast && (
                  <div style={{ width: 2, flex: 1, minHeight: 22, background: colors.border, marginTop: 2 }} />
                )}
              </div>
              {/* Label + timestamp + note */}
              <div style={{ paddingBottom: isLast ? 0 : 14, flex: 1 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: step.state === "current" ? 800 : 600,
                    color: upcoming ? colors.textFaint : colors.text,
                  }}
                >
                  {stepLabel(step)}
                </div>
                <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 1 }}>
                  {step.timestamp ? formatDateTime(step.timestamp) : upcoming ? "Pending" : "—"}
                  {step.note ? ` · ${step.note}` : ""}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
