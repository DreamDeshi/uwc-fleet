import { api, loadStoredTokens } from "../services/api";
import {
  getQueuedLocations,
  getQueuedCount,
  removeLocations,
} from "./locationQueue";

// The single place GPS points leave the phone. BOTH the foreground hook
// (useTripLocation) and the headless background task (backgroundLocation) flush
// through here, so the offline/batching contract can never diverge between them:
// POST the whole durable queue, then drop exactly what the server accepted.

export interface FlushResult {
  count: number; // points still queued after the attempt (unsent backlog)
  // trip_ids the server reports are NO LONGER active (not in_progress). Lets the
  // background task self-stop a trip that ended while the app was closed — e.g.
  // an admin cancelled it — without needing the app open. Empty on any failure.
  inactiveTripIds: string[];
}

// A module-level lock so a flush from the 30s tick can't overlap one triggered
// by a reconnect (which would double-send the same points). In the headless
// task this starts fresh each cold launch, which is correct.
let flushing = false;

// `ensureAuth` — the headless background task has no live AuthContext, so the
// in-memory access token may be unset; loading it from storage lets the axios
// interceptor attach the driver JWT (and its 401-refresh still works).
export async function flushQueuedLocations(ensureAuth = false): Promise<FlushResult> {
  if (flushing) return { count: await getQueuedCount(), inactiveTripIds: [] };
  flushing = true;
  try {
    if (ensureAuth) await loadStoredTokens();
    const points = await getQueuedLocations();
    let inactiveTripIds: string[] = [];
    if (points.length > 0) {
      const res = await api.post<{ accepted: number; inactive_trip_ids?: string[] }>(
        "/locations",
        { points }
      );
      inactiveTripIds = res.data?.inactive_trip_ids ?? [];
      await removeLocations(points);
    }
    return { count: await getQueuedCount(), inactiveTripIds };
  } catch {
    // offline or server error — leave the queue intact for the next attempt
    return { count: await getQueuedCount(), inactiveTripIds: [] };
  } finally {
    flushing = false;
  }
}
