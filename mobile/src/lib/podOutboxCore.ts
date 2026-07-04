// POD OFFLINE OUTBOX — pure core (queue ops + flush state machine).
//
// A driver at a rural drop with no signal must not be blocked from completing
// the delivery: the POD photo, the K2 ack and the "Delivered" confirm are
// captured locally, queued durably, and replayed automatically when
// connectivity returns. The server already makes every replayed step safe:
//   • POD upload   — overwrites the same Cloudinary publicId (ticket-stop-N),
//                    no status guard → a retry never duplicates anything.
//   • K2 ack       — a plain idempotent flag PATCH.
//   • delivered    — write-once finalization; "already recorded" replies
//                    (STOP_ALREADY_DELIVERED / TRIP_ALREADY_FINALIZED /
//                    TRIP_NOT_ACTIVE) are treated as SUCCESS, mirroring the
//                    on-screen reconcile logic (90ef885).
//
// This file has NO imports (no storage, no network, no react-native) so the
// money-adjacent replay logic is unit-testable in plain node — the same
// pure-core discipline as the API's incentive engine. The AsyncStorage edge
// lives in podOutbox.ts; the real API + triggers in hooks/usePodOutbox.ts.

export interface OutboxPhoto {
  uri: string; // native: file:// in cache; web: data: URI (durable across reloads)
  name: string;
  type: string;
}

export interface PodOutboxItem {
  tripId: string;
  stopId: string; // one item per stop — the outbox's natural key
  /** Driver tapped "Arrived" offline (it gates the POD UI, so it queues too). */
  markArrived: boolean;
  /** The arrived step committed server-side. */
  arrivedMarked: boolean;
  /** Photo still to upload; null once uploaded (or never captured offline). */
  photo: OutboxPhoto | null;
  /** The photo step committed server-side — a re-flush must NOT repeat it. */
  photoUploaded: boolean;
  /** Driver ticked the K2 customs ack while offline. */
  k2FormAck: boolean;
  /** The K2 step committed server-side. */
  k2Acked: boolean;
  /** Driver tapped "Delivered" — flush finishes the stop, not just the photo. */
  confirmDelivered: boolean;
  queuedAt: string; // ISO — display + identity for safe concurrent reconcile
  /** Consecutive non-network API failures (give up at MAX_API_FAILURES). */
  apiFailures: number;
}

// Per-step "already recorded" replies — the server is at (or past) the state
// that step wanted: mark the step committed and carry on. Step-scoped because
// the SAME code means different things on different endpoints (INVALID_STATUS
// is "already marked arrived" on the arrived action but a genuine refusal on
// start). Must stay in sync with ActiveTripScreen's reconcile code sets.
export const ARRIVED_STEP_ALREADY_CODES = ["INVALID_STATUS"] as const;
export const DELIVERED_STEP_ALREADY_CODES = [
  "STOP_ALREADY_DELIVERED",
  "TRIP_ALREADY_FINALIZED",
  "TRIP_NOT_ACTIVE",
] as const;

// The item can never succeed for THIS driver anymore (trip reassigned or
// gone) — drop it and let the screens show server truth.
export const OUTBOX_STALE_CODES = ["FORBIDDEN", "TRIP_NOT_FOUND", "STOP_NOT_FOUND"] as const;

// A persistent non-network API error (e.g. an unexpected 500) must not retry
// forever — give up after this many attempts and surface it.
export const MAX_API_FAILURES = 5;

// Web localStorage is ~5MB and a queued web photo is a ~700KB data URI, so cap
// the outbox well below that. One driver has ONE active trip (one-active rule)
// with a handful of stops — 15 queued deliveries means something is very wrong;
// dropping the OLDEST mirrors locationQueue's newest-wins policy.
export const MAX_OUTBOX = 15;

// ── Queue ops ────────────────────────────────────────────────────────────

export interface OutboxPatch {
  tripId: string;
  stopId: string;
  markArrived?: boolean;
  photo?: OutboxPhoto;
  k2FormAck?: boolean;
  confirmDelivered?: boolean;
}

/**
 * Upsert by stopId. Merging never un-sets an intent (a queued Delivered
 * survives a later photo retake); a NEW photo resets photoUploaded so the
 * retake replaces the queued shot.
 */
export function mergeOutboxItem(
  items: PodOutboxItem[],
  patch: OutboxPatch,
  queuedAt: string
): PodOutboxItem[] {
  const existing = items.find((i) => i.stopId === patch.stopId);
  const merged: PodOutboxItem = {
    tripId: patch.tripId,
    stopId: patch.stopId,
    markArrived: patch.markArrived ?? existing?.markArrived ?? false,
    arrivedMarked: existing?.arrivedMarked ?? false, // re-tapping Arrived is idempotent
    photo: patch.photo ?? existing?.photo ?? null,
    photoUploaded: patch.photo ? false : existing?.photoUploaded ?? false,
    k2FormAck: patch.k2FormAck ?? existing?.k2FormAck ?? false,
    k2Acked: patch.k2FormAck ? false : existing?.k2Acked ?? false,
    confirmDelivered: patch.confirmDelivered ?? existing?.confirmDelivered ?? false,
    queuedAt: existing?.queuedAt ?? queuedAt,
    apiFailures: 0, // fresh driver intent → give the item a fresh retry budget
  };
  const rest = items.filter((i) => i.stopId !== patch.stopId);
  const next = [...rest, merged];
  return next.length > MAX_OUTBOX ? next.slice(next.length - MAX_OUTBOX) : next;
}

export function findOutboxItem(
  items: PodOutboxItem[],
  stopId: string
): PodOutboxItem | undefined {
  return items.find((i) => i.stopId === stopId);
}

// ── Flush state machine ──────────────────────────────────────────────────

export type FlushOutcome = "synced" | "kept" | "dropped";

export interface PodOutboxApi {
  /** PATCH status=arrived for the stop. INVALID_STATUS = already arrived. */
  markArrived(item: PodOutboxItem): Promise<void>;
  /** POST the queued photo. Server overwrites the same publicId — retry-safe. */
  uploadPod(item: PodOutboxItem): Promise<void>;
  /** PATCH k2_form_ack: true. Idempotent. */
  ackK2(item: PodOutboxItem): Promise<void>;
  /** PATCH status=delivered for the stop. Server is write-once. */
  confirmDelivered(item: PodOutboxItem): Promise<void>;
  errorCode(err: unknown): string | null;
  isNetworkError(err: unknown): boolean;
  /** Optional checkpoint after each item so progress survives a mid-flush kill. */
  persist?(outcomes: ItemOutcome[]): Promise<void>;
}

export interface ItemOutcome {
  item: PodOutboxItem; // with step progress applied
  outcome: FlushOutcome;
}

/**
 * Replay one item's remaining steps in order: arrived → photo → K2 ack →
 * delivered. Each committed step is marked on the item so a later retry NEVER
 * repeats it (the idempotency requirement: a partial earlier success must not
 * duplicate). A step's "already recorded" reply counts as that step
 * committing — a lost-response earlier attempt, not an error.
 */
async function flushOneItem(input: PodOutboxItem, api: PodOutboxApi): Promise<ItemOutcome> {
  const item: PodOutboxItem = { ...input };

  // Run one step; swallow its step-scoped already-recorded codes as success.
  const step = async (fn: () => Promise<void>, alreadyCodes: readonly string[]) => {
    try {
      await fn();
    } catch (err) {
      if (!api.isNetworkError(err) && alreadyCodes.includes(api.errorCode(err) ?? "")) return;
      throw err;
    }
  };

  try {
    if (item.markArrived && !item.arrivedMarked) {
      await step(() => api.markArrived(item), ARRIVED_STEP_ALREADY_CODES);
      item.arrivedMarked = true;
    }
    if (item.photo && !item.photoUploaded) {
      await step(() => api.uploadPod(item), []);
      item.photoUploaded = true;
      item.photo = null; // free the (possibly large) queued image immediately
    }
    if (item.k2FormAck && !item.k2Acked) {
      await step(() => api.ackK2(item), []);
      item.k2Acked = true;
    }
    if (item.confirmDelivered) {
      await step(() => api.confirmDelivered(item), DELIVERED_STEP_ALREADY_CODES);
    }
    return { item, outcome: "synced" };
  } catch (err) {
    if (api.isNetworkError(err)) {
      // Still no signal — keep, with whatever step progress we made.
      return { item, outcome: "kept" };
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

/** Replay every item sequentially (stop order matters for multi-stop trips). */
export async function flushOutboxItems(
  items: PodOutboxItem[],
  api: PodOutboxApi
): Promise<FlushResult> {
  const outcomes: ItemOutcome[] = [];
  for (const item of items) {
    outcomes.push(await flushOneItem(item, api));
    await api.persist?.(outcomes);
  }
  return {
    outcomes,
    synced: outcomes.filter((o) => o.outcome === "synced").length,
    dropped: outcomes.filter((o) => o.outcome === "dropped").length,
  };
}

/**
 * Fold flush outcomes back into the CURRENT stored queue (which may have
 * gained or replaced items while the flush was in flight — same reason
 * locationQueue removes exactly-what-was-sent instead of clearing).
 * Identity = stopId + queuedAt: an item the driver re-queued mid-flush is a
 * DIFFERENT intent and must survive untouched.
 */
export function reconcileOutboxAfterFlush(
  stored: PodOutboxItem[],
  outcomes: ItemOutcome[]
): PodOutboxItem[] {
  const byKey = new Map(outcomes.map((o) => [`${o.item.stopId}|${o.item.queuedAt}`, o]));
  const next: PodOutboxItem[] = [];
  for (const s of stored) {
    const o = byKey.get(`${s.stopId}|${s.queuedAt}`);
    if (!o) {
      next.push(s); // added/replaced during the flush — keep as-is
    } else if (o.outcome === "kept") {
      next.push(o.item); // keep, with step progress persisted
    }
    // synced/dropped → removed
  }
  return next;
}
