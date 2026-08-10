import { api, apiErrorCode, isNetworkError, loadStoredTokens } from "../services/api";
import {
  getQueuedLocations,
  getQueuedCount,
  removeLocations,
  type QueuedPoint,
} from "./locationQueue";

// The single place GPS points leave the phone. BOTH the foreground hook
// (useTripLocation) and the headless background task (backgroundLocation) flush
// through here, so the offline/batching contract can never diverge between them:
// POST the queue, then drop exactly what the server accepted.
//
// ── Why this posts PER TRIP and not in one batch ─────────────────────────────
// It used to POST the entire queue as a single request. The queue is one global
// buffer holding points for EVERY trip the phone has recorded, and the server
// rejects the WHOLE batch if any single trip_id in it is unknown (404
// TRIP_NOT_FOUND) or belongs to another driver (403 FORBIDDEN) — see
// api/src/routes/locations.ts. A bare catch then put the queue back untouched
// and the next flush sent the byte-identical payload again.
//
// So one dead trip_id took every other trip's points down with it, forever. On
// 10 Aug 2026 a driver on the live trial sat at "Offline · 500 queued" — the
// buffer's hard cap — on a full 5G signal, discarding its oldest reading every
// 30s to make room for a new one it also could not send. Nothing surfaced why:
// the error was swallowed, and the pill says "Offline" for ANY backlog.
//
// Grouping by trip means a poison trip can only ever cost its own points.

/** Server replies that can never succeed on a retry, so the points are dropped
 *  rather than retried forever. A deleted trip does not come back, and a trip
 *  reassigned to another driver never becomes this driver's again. Mirrors the
 *  POD outbox's OUTBOX_STALE_CODES branch (lib/podOutboxCore.ts). */
const PERMANENT_CODES = ["TRIP_NOT_FOUND", "FORBIDDEN"];

export interface FlushResult {
  count: number; // points still queued after the attempt (unsent backlog)
  // trip_ids the server reports are NO LONGER active (not in_progress). Lets the
  // background task self-stop a trip that ended while the app was closed — e.g.
  // an admin cancelled it — without needing the app open. Empty on any failure.
  inactiveTripIds: string[];
  /** Points discarded as permanently unsendable. Surfaced for tests and logs,
   *  deliberately NOT shown to the driver: a lost GPS breadcrumb is not his to
   *  act on, unlike a POD, which is why that outbox does tell him. */
  dropped: number;
}

// A module-level lock so a flush from the 30s tick can't overlap one triggered
// by a reconnect (which would double-send the same points). In the headless
// task this starts fresh each cold launch, which is correct.
let flushing = false;

/** Group by trip so one trip's rejection cannot strand another's points. */
function byTrip(points: QueuedPoint[]): Map<string, QueuedPoint[]> {
  const groups = new Map<string, QueuedPoint[]>();
  for (const p of points) {
    const existing = groups.get(p.trip_id);
    if (existing) existing.push(p);
    else groups.set(p.trip_id, [p]);
  }
  return groups;
}

// `ensureAuth` — the headless background task has no live AuthContext, so the
// in-memory access token may be unset; loading it from storage lets the axios
// interceptor attach the driver JWT (and its 401-refresh still works).
export async function flushQueuedLocations(ensureAuth = false): Promise<FlushResult> {
  if (flushing) return { count: await getQueuedCount(), inactiveTripIds: [], dropped: 0 };
  flushing = true;
  try {
    if (ensureAuth) await loadStoredTokens();
    const points = await getQueuedLocations();
    if (points.length === 0) return { count: 0, inactiveTripIds: [], dropped: 0 };

    const inactiveTripIds: string[] = [];
    let dropped = 0;

    for (const group of byTrip(points).values()) {
      try {
        const res = await api.post<{ accepted: number; inactive_trip_ids?: string[] }>(
          "/locations",
          { points: group }
        );
        inactiveTripIds.push(...(res.data?.inactive_trip_ids ?? []));
        await removeLocations(group);
      } catch (err) {
        // No reply at all — still offline. Keep the group and try again later;
        // this is the case the durable queue exists for.
        if (isNetworkError(err)) continue;
        // A real server decision. Permanent ones are dropped so they can never
        // wedge the queue; everything else (5xx, a 401 mid-refresh) is left
        // queued, because those DO succeed on a later attempt.
        if (PERMANENT_CODES.includes(apiErrorCode(err) ?? "")) {
          await removeLocations(group);
          dropped += group.length;
        }
      }
    }

    return { count: await getQueuedCount(), inactiveTripIds, dropped };
  } catch {
    // Storage failure or anything else unforeseen. This function must never
    // throw: useTripLocation calls it from a ref callback with no catch, and
    // backgroundLocation runs headless where a rejection is invisible.
    return { count: await getQueuedCount().catch(() => 0), inactiveTripIds: [], dropped: 0 };
  } finally {
    flushing = false;
  }
}
