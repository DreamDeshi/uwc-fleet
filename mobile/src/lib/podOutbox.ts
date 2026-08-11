import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  flushOutboxItems,
  mergeOutboxItem,
  reconcileOutboxAfterFlush,
  type FlushOptions,
  type FlushResult,
  type ItemOutcome,
  type OutboxPatch,
  type PodOutboxApi,
  type PodOutboxItem,
} from "./podOutboxCore";
import { persistPodPhoto, sweepPodPhotos } from "./podPhotoStore";

// POD OFFLINE OUTBOX — durable storage edge (AsyncStorage; localStorage-backed
// on the web build) + change notification. All queue/merge/replay LOGIC lives
// in podOutboxCore.ts (pure, unit-tested); the real API + flush triggers live
// in hooks/usePodOutbox.ts. Same layering as locationQueue + useTripLocation.

export * from "./podOutboxCore";

const OUTBOX_KEY = "uwc.podOutbox";

type Listener = () => void;
const listeners = new Set<Listener>();

/** Screens subscribe to re-read the outbox whenever it changes. */
export function subscribePodOutbox(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn());
}

// Reading the queue can fail in two very different ways, and collapsing them
// into "[]" is how a driver loses delivered work.
//
// Every mutation below is read-modify-write. When a read error became an empty
// array, the very next enqueue wrote a ONE-ITEM array over a queue that might
// have held a day of deliveries — silently, permanently, and reported to the
// driver as "saved offline". The file already had the right instinct one
// function down ("write errors PROPAGATE ... rather than telling the driver
// 'saved' when nothing was"); the read path contradicted it.
//
//   STORAGE FAILURE (AsyncStorage threw) — we do not know what is stored, so no
//   caller may write. Mutators refuse; the display path shows an empty list.
//   CORRUPT / NON-ARRAY VALUE — the stored bytes are unusable, so the queue has
//   to start clean or the driver can never queue anything again. The raw value
//   is QUARANTINED under its own key first, so it is recoverable rather than
//   overwritten by the next write.
type ReadOutcome =
  | { ok: true; items: PodOutboxItem[] }
  | { ok: false; error: unknown };

const CORRUPT_KEY_PREFIX = "uwc.podOutbox.corrupt";

/** Keep unparseable bytes instead of destroying them. Best effort by design. */
async function quarantineCorrupt(raw: string): Promise<void> {
  try {
    await AsyncStorage.setItem(`${CORRUPT_KEY_PREFIX}.${Date.now()}`, raw);
  } catch {
    // Storage is already misbehaving; failing to quarantine must not also block
    // the driver from queueing the delivery in front of them.
  }
}

async function readOutboxOutcome(): Promise<ReadOutcome> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(OUTBOX_KEY);
  } catch (error) {
    return { ok: false, error };
  }
  if (!raw) return { ok: true, items: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return { ok: true, items: parsed as PodOutboxItem[] };
  } catch {
    // fall through — unparseable is handled the same as a non-array value
  }
  await quarantineCorrupt(raw);
  return { ok: true, items: [] };
}

async function readOutbox(): Promise<PodOutboxItem[]> {
  const outcome = await readOutboxOutcome();
  return outcome.ok ? outcome.items : [];
}

// Write errors (e.g. web localStorage quota) PROPAGATE: the caller must fall
// back to the normal error path rather than telling the driver "saved" when
// nothing was.
async function writeOutbox(items: PodOutboxItem[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  // Collect stored photos nothing references any more — items just synced,
  // dropped, retaken, or superseded by a direct upload. Doing it here, against
  // the list actually written, covers every one of those paths without a delete
  // threaded through each. Never throws (lib/podPhotoStore).
  sweepPodPhotos(items.map((i) => i.photo?.uri).filter((u): u is string => Boolean(u)));
  notify();
}

export async function getPodOutbox(): Promise<PodOutboxItem[]> {
  return readOutbox();
}

/**
 * Queue (or merge into) a stop's pending delivery. Throws if storage fails —
 * on the READ as well as the write. Callers already treat a throw as "storage
 * full/unavailable, show the normal error" (ActiveTripScreen.queueDeliveredOffline),
 * which is exactly right: refusing to queue is recoverable, overwriting the
 * queue is not.
 */
export async function enqueuePodItem(patch: OutboxPatch): Promise<void> {
  const outcome = await readOutboxOutcome();
  if (!outcome.ok) {
    throw outcome.error instanceof Error
      ? outcome.error
      : new Error("POD outbox unreadable — refusing to overwrite it");
  }
  // ⚠ MOVE THE PHOTO SOMEWHERE THE OS WILL NOT RECLAIM, BEFORE STORING THE
  // REFERENCE. The camera writes into the CACHE directory, which Android evicts
  // under storage pressure without touching AsyncStorage — leaving a valid
  // outbox entry pointing at a file that no longer exists, which then fails its
  // five attempts and drops the delivery. See lib/podPhotoStore.
  const persisted: OutboxPatch = patch.photo
    ? { ...patch, photo: { ...patch.photo, uri: persistPodPhoto(patch.photo.uri, patch.stopId, Date.now()) } }
    : patch;
  await writeOutbox(mergeOutboxItem(outcome.items, persisted, new Date().toISOString()));
}

/** Drop a stop's item (the stop completed through the normal online path). */
export async function removePodItem(stopId: string): Promise<void> {
  const outcome = await readOutboxOutcome();
  if (!outcome.ok) return; // unreadable — a stale item replays idempotently; a lost queue does not
  if (!outcome.items.some((i) => i.stopId === stopId)) return;
  await writeOutbox(outcome.items.filter((i) => i.stopId !== stopId));
}

/**
 * A DIRECT (online) POD upload succeeded for this stop — clear the queued
 * photo so a later flush can't pointlessly re-upload it; if nothing else is
 * pending on the item, remove it entirely.
 */
export async function noteDirectPodUpload(stopId: string): Promise<void> {
  const outcome = await readOutboxOutcome();
  if (!outcome.ok) return; // same reasoning as removePodItem — never write blind
  const items = outcome.items;
  const item = items.find((i) => i.stopId === stopId);
  if (!item) return;
  if (!item.confirmDelivered && !(item.k2FormAck && !item.k2Acked)) {
    await writeOutbox(items.filter((i) => i.stopId !== stopId));
    return;
  }
  await writeOutbox(
    items.map((i) => (i.stopId === stopId ? { ...i, photo: null, photoUploaded: true } : i))
  );
}

// One flush at a time — a reconnect event and the periodic tick must not
// replay the same item concurrently (same lock idea as useTripLocation).
let flushing = false;

/** Read → replay → fold results back into whatever is stored now. */
export async function flushPodOutbox(
  api: PodOutboxApi,
  opts: FlushOptions = {}
): Promise<FlushResult> {
  if (flushing) return { outcomes: [], synced: 0, dropped: 0 };
  flushing = true;
  try {
    const read = await readOutboxOutcome();
    // Unreadable: replaying nothing is safe, guessing is not.
    if (!read.ok) return { outcomes: [], synced: 0, dropped: 0 };
    const snapshot = read.items;
    if (snapshot.length === 0) return { outcomes: [], synced: 0, dropped: 0 };
    // Checkpoint after every item: progress (e.g. photoUploaded) survives the
    // app being killed mid-flush, and completed items leave the queue at once.
    const checkpoint = async (outcomes: ItemOutcome[]) => {
      // Re-read so a concurrently queued item is not clobbered — but if THAT
      // read fails, reconciling against [] would drop every kept item. Skip the
      // checkpoint instead; the work stays queued and replays next flush.
      const current = await readOutboxOutcome();
      if (!current.ok) return;
      await writeOutbox(reconcileOutboxAfterFlush(current.items, outcomes));
    };
    return await flushOutboxItems(snapshot, { ...api, persist: checkpoint }, opts);
  } finally {
    flushing = false;
  }
}
