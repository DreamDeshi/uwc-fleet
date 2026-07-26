// EXCEPTION OFFLINE OUTBOX — pure core (queue ops + flush state machine).
//
// A driver who hits a problem at a rural drop with no signal must still be able
// to "Report Exception": the category, reason, GPS snapshot and the required
// photo are captured locally, queued durably, and replayed when connectivity
// returns. The server makes replay safe via operation UUIDs — the report is
// idempotent on `client_occurrence_id` (a replay returns the SAME exception, not
// a duplicate), so a lost-response first attempt never double-reports.
//
// This file has NO imports (no storage, no network, no react-native) so the
// replay logic is unit-testable in plain node — same pure-core discipline as
// podOutboxCore.ts. The AsyncStorage edge + the real API live in the hook layer.

export interface OutboxPhoto {
  uri: string;
  name: string;
  type: string;
}

export interface ExceptionOutboxItem {
  tripId: string;
  /** Idempotency key for the report — the outbox's natural key. */
  clientOccurrenceId: string;
  clientActionId: string;
  clientEvidenceId: string;
  category: string;
  reason: string;
  tripStopId: string | null;
  photo: OutboxPhoto; // mandatory evidence — a report is never queued without it
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  /** Device capture time (ISO) — preserved distinctly from server receipt time. */
  clientAt: string;
  queuedAt: string;
  /** Consecutive non-network API failures (give up at MAX_API_FAILURES). */
  apiFailures: number;
}

// The report can NEVER succeed for this driver/trip anymore — drop it and let the
// screen show server truth. EXCEPTION_ALREADY_OPEN: a DIFFERENT exception is
// already open (a same-occurrence replay would instead return 200 success);
// TRIP_NOT_IN_PROGRESS: the trip finished/aborted before we synced; NOT_FOUND:
// the feature is disabled or the trip is gone.
export const OUTBOX_STALE_CODES = [
  "EXCEPTION_ALREADY_OPEN",
  "TRIP_NOT_IN_PROGRESS",
  "TRIP_NOT_FOUND",
  "FORBIDDEN",
  "NOT_FOUND",
] as const;

export const MAX_API_FAILURES = 5;

// One driver has ONE active trip with at most ONE open exception, so the queue is
// tiny; cap it well below storage limits and drop the OLDEST (newest-wins).
export const MAX_OUTBOX = 10;

export interface OutboxPatch {
  tripId: string;
  clientOccurrenceId: string;
  clientActionId: string;
  clientEvidenceId: string;
  category: string;
  reason: string;
  tripStopId?: string | null;
  photo: OutboxPhoto;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  clientAt: string;
}

/** Upsert by clientOccurrenceId. A re-queue of the same occurrence refreshes the
 *  payload and resets the retry budget (fresh driver intent). */
export function mergeOutboxItem(
  items: ExceptionOutboxItem[],
  patch: OutboxPatch,
  queuedAt: string
): ExceptionOutboxItem[] {
  const existing = items.find((i) => i.clientOccurrenceId === patch.clientOccurrenceId);
  const merged: ExceptionOutboxItem = {
    tripId: patch.tripId,
    clientOccurrenceId: patch.clientOccurrenceId,
    clientActionId: patch.clientActionId,
    clientEvidenceId: patch.clientEvidenceId,
    category: patch.category,
    reason: patch.reason,
    tripStopId: patch.tripStopId ?? null,
    photo: patch.photo,
    lat: patch.lat ?? null,
    lng: patch.lng ?? null,
    accuracyM: patch.accuracyM ?? null,
    clientAt: patch.clientAt,
    queuedAt: existing?.queuedAt ?? queuedAt,
    apiFailures: 0,
  };
  const rest = items.filter((i) => i.clientOccurrenceId !== patch.clientOccurrenceId);
  const next = [...rest, merged];
  return next.length > MAX_OUTBOX ? next.slice(next.length - MAX_OUTBOX) : next;
}

// ── Flush state machine ────────────────────────────────────────────────────

export type FlushOutcome = "synced" | "kept" | "dropped";

export interface ExceptionOutboxApi {
  /** POST the queued report (multipart). Idempotent on client_occurrence_id. */
  report(item: ExceptionOutboxItem): Promise<void>;
  errorCode(err: unknown): string | null;
  isNetworkError(err: unknown): boolean;
}

export interface ItemOutcome {
  item: ExceptionOutboxItem;
  outcome: FlushOutcome;
}

async function flushOneItem(input: ExceptionOutboxItem, api: ExceptionOutboxApi): Promise<ItemOutcome> {
  const item: ExceptionOutboxItem = { ...input };
  try {
    await api.report(item);
    return { item, outcome: "synced" };
  } catch (err) {
    if (api.isNetworkError(err)) {
      return { item, outcome: "kept" }; // still offline — retry later
    }
    const code = api.errorCode(err);
    if ((OUTBOX_STALE_CODES as readonly string[]).includes(code ?? "")) {
      return { item, outcome: "dropped" };
    }
    item.apiFailures += 1;
    return { item, outcome: item.apiFailures >= MAX_API_FAILURES ? "dropped" : "kept" };
  }
}

export interface FlushResult {
  outcomes: ItemOutcome[];
  synced: number;
  dropped: number;
}

/** Replay every queued report sequentially. */
export async function flushOutboxItems(
  items: ExceptionOutboxItem[],
  api: ExceptionOutboxApi
): Promise<FlushResult> {
  const outcomes: ItemOutcome[] = [];
  for (const item of items) {
    outcomes.push(await flushOneItem(item, api));
  }
  return {
    outcomes,
    synced: outcomes.filter((o) => o.outcome === "synced").length,
    dropped: outcomes.filter((o) => o.outcome === "dropped").length,
  };
}

/**
 * Fold outcomes back into the CURRENT stored queue (which may have gained items
 * mid-flush). Identity = clientOccurrenceId + queuedAt: a re-queued occurrence is
 * a different intent and survives untouched. synced/dropped are removed; kept
 * (with any incremented failure count) is retained.
 */
export function reconcileOutboxAfterFlush(
  stored: ExceptionOutboxItem[],
  outcomes: ItemOutcome[]
): ExceptionOutboxItem[] {
  const byKey = new Map(outcomes.map((o) => [`${o.item.clientOccurrenceId}|${o.item.queuedAt}`, o]));
  const next: ExceptionOutboxItem[] = [];
  for (const s of stored) {
    const o = byKey.get(`${s.clientOccurrenceId}|${s.queuedAt}`);
    if (!o) next.push(s);
    else if (o.outcome === "kept") next.push(o.item);
    // synced/dropped → removed
  }
  return next;
}
