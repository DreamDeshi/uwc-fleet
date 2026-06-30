import type { TripEvent, TripStatus, StopStatus } from "@prisma/client";

// ── Inputs (a subset of a Trip with stops + status_history) ──────────────
// Kept as a plain shape so the builder is pure and unit-testable without a DB.

export interface TimelineStopInput {
  id: string;
  sequence: number;
  status: StopStatus;
  arrived_at: Date | null;
  delivered_at: Date | null;
  consignee?: { company_name: string; area: string | null; zone_code: string } | null;
}

export interface TimelineHistoryInput {
  event: TripEvent;
  stop_id: string | null;
  note: string | null;
  created_at: Date;
}

export interface TimelineTripInput {
  status: TripStatus;
  created_at: Date;
  is_external: boolean;
  rejection_reason: string | null;
  driver?: { name: string } | null;
  truck_plate?: string | null;
  stops: TimelineStopInput[];
  status_history: TimelineHistoryInput[];
}

// ── Output ───────────────────────────────────────────────────────────────
// `event` is the canonical key each client maps to its own i18n string, so the
// label wording lives in the UI (admin EN-only; mobile EN/MS/ZH) — not here.

export type StepState = "done" | "current" | "upcoming";

export interface TimelineStep {
  event: TripEvent;
  state: StepState;
  timestamp: string | null; // ISO 8601, or null if the milestone isn't reached yet
  note?: string | null;
  stopId?: string;
  stopSequence?: number;
  stopLabel?: string; // consignee area / company, for per-stop steps
}

const iso = (d: Date | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

function stopLabel(stop: TimelineStopInput): string {
  const c = stop.consignee;
  return c?.area || c?.company_name || c?.zone_code || `Stop ${stop.sequence}`;
}

function assignNote(trip: TimelineTripInput): string | null {
  if (trip.driver?.name && trip.truck_plate) return `${trip.driver.name} · ${trip.truck_plate}`;
  return trip.driver?.name ?? trip.truck_plate ?? null;
}

/**
 * Build the adaptive status timeline for a trip. Milestones follow UWC's real
 * lifecycle — plant → one or more consignee delivery stops — rather than a fixed
 * pickup→delivery bar:
 *
 *   Booked → Assigned → En route → [per stop: Arrived → Delivered] → Completed
 *
 * with terminal branches for Rejected, Cancelled, and Assigned-to-forwarder.
 *
 * History rows are authoritative when present; for trips created before this
 * feature (or seed/demo trips) timestamps fall back to fields the trip already
 * stores — created_at, and each stop's arrived_at / delivered_at — so every trip
 * renders a sensible timeline.
 */
export function buildTripTimeline(trip: TimelineTripInput): TimelineStep[] {
  const hist = trip.status_history ?? [];
  const firstOf = (event: TripEvent, stopId?: string) =>
    hist.find((h) => h.event === event && (stopId === undefined || h.stop_id === stopId));

  const steps: TimelineStep[] = [];

  // 1. Booked — always the first milestone.
  steps.push({
    event: "booked",
    state: "done",
    timestamp: iso(firstOf("booked")?.created_at ?? trip.created_at),
  });

  // Terminal — Rejected: a rejected booking never gets assigned.
  if (trip.status === "rejected") {
    const h = firstOf("rejected");
    steps.push({
      event: "rejected",
      state: "done",
      timestamp: iso(h?.created_at ?? null),
      note: h?.note ?? trip.rejection_reason ?? null,
    });
    return steps;
  }

  // Terminal — Assigned to an external forwarder: no driver/stop flow.
  if (trip.is_external || firstOf("assigned_external")) {
    const h = firstOf("assigned_external");
    steps.push({
      event: "assigned_external",
      state: "done",
      timestamp: iso(h?.created_at ?? null),
      note: h?.note ?? null,
    });
    return steps;
  }

  const reachedAssigned =
    trip.status === "assigned" ||
    trip.status === "in_progress" ||
    trip.status === "completed" ||
    !!firstOf("assigned");

  // Terminal — Cancelled: show whatever was reached (Assigned, if it got that
  // far) then Cancelled. No En route / stops / Completed.
  if (trip.status === "cancelled") {
    if (reachedAssigned) {
      const h = firstOf("assigned");
      steps.push({
        event: "assigned",
        state: "done",
        timestamp: iso(h?.created_at ?? null),
        note: h?.note ?? assignNote(trip),
      });
    }
    const h = firstOf("cancelled");
    steps.push({
      event: "cancelled",
      state: "done",
      timestamp: iso(h?.created_at ?? null),
      note: h?.note ?? null,
    });
    return steps;
  }

  const reachedStarted =
    trip.status === "in_progress" || trip.status === "completed" || !!firstOf("started");
  const reachedCompleted = trip.status === "completed" || !!firstOf("completed");

  // Normal path — always render the full happy-path skeleton so a pending trip
  // shows every milestone ahead of it; unreached steps are "upcoming".

  // 2. Assigned (driver + truck).
  const assignedH = firstOf("assigned");
  steps.push({
    event: "assigned",
    state: reachedAssigned ? "done" : "upcoming",
    timestamp: iso(assignedH?.created_at ?? null),
    note: assignedH?.note ?? assignNote(trip),
  });

  // 3. En route (driver started the trip).
  steps.push({
    event: "started",
    state: reachedStarted ? "done" : "upcoming",
    timestamp: iso(firstOf("started")?.created_at ?? null),
  });

  // 4. Per-stop Arrived → Delivered, in sequence.
  for (const stop of [...trip.stops].sort((a, b) => a.sequence - b.sequence)) {
    const arrived = stop.status === "arrived" || stop.status === "delivered";
    const delivered = stop.status === "delivered";
    steps.push({
      event: "stop_arrived",
      state: arrived ? "done" : "upcoming",
      timestamp: iso(stop.arrived_at ?? firstOf("stop_arrived", stop.id)?.created_at ?? null),
      stopId: stop.id,
      stopSequence: stop.sequence,
      stopLabel: stopLabel(stop),
    });
    steps.push({
      event: "stop_delivered",
      state: delivered ? "done" : "upcoming",
      timestamp: iso(stop.delivered_at ?? firstOf("stop_delivered", stop.id)?.created_at ?? null),
      stopId: stop.id,
      stopSequence: stop.sequence,
      stopLabel: stopLabel(stop),
    });
  }

  // 5. Completed.
  const lastDelivered = trip.stops.reduce<Date | null>(
    (latest, s) =>
      s.delivered_at && (!latest || s.delivered_at > latest) ? s.delivered_at : latest,
    null
  );
  steps.push({
    event: "completed",
    state: reachedCompleted ? "done" : "upcoming",
    timestamp: iso(firstOf("completed")?.created_at ?? (reachedCompleted ? lastDelivered : null)),
  });

  // Mark the next actionable milestone as "current" while the trip is live.
  if (!reachedCompleted) {
    const next = steps.find((s) => s.state === "upcoming");
    if (next) next.state = "current";
  }

  return steps;
}
