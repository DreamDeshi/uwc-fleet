import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  flushOutboxItems,
  mergeOutboxItem,
  reconcileOutboxAfterFlush,
  type FlushResult,
  type ItemOutcome,
  type OutboxPatch,
  type PodOutboxApi,
  type PodOutboxItem,
} from "./podOutboxCore";

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

async function readOutbox(): Promise<PodOutboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as PodOutboxItem[]) : [];
  } catch {
    return []; // corrupt JSON — start clean rather than crash the driver flow
  }
}

// Write errors (e.g. web localStorage quota) PROPAGATE: the caller must fall
// back to the normal error path rather than telling the driver "saved" when
// nothing was.
async function writeOutbox(items: PodOutboxItem[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  notify();
}

export async function getPodOutbox(): Promise<PodOutboxItem[]> {
  return readOutbox();
}

/** Queue (or merge into) a stop's pending delivery. Throws if storage fails. */
export async function enqueuePodItem(patch: OutboxPatch): Promise<void> {
  const items = await readOutbox();
  await writeOutbox(mergeOutboxItem(items, patch, new Date().toISOString()));
}

/** Drop a stop's item (the stop completed through the normal online path). */
export async function removePodItem(stopId: string): Promise<void> {
  const items = await readOutbox();
  if (!items.some((i) => i.stopId === stopId)) return;
  await writeOutbox(items.filter((i) => i.stopId !== stopId));
}

/**
 * A DIRECT (online) POD upload succeeded for this stop — clear the queued
 * photo so a later flush can't pointlessly re-upload it; if nothing else is
 * pending on the item, remove it entirely.
 */
export async function noteDirectPodUpload(stopId: string): Promise<void> {
  const items = await readOutbox();
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
export async function flushPodOutbox(api: PodOutboxApi): Promise<FlushResult> {
  if (flushing) return { outcomes: [], synced: 0, dropped: 0 };
  flushing = true;
  try {
    const snapshot = await readOutbox();
    if (snapshot.length === 0) return { outcomes: [], synced: 0, dropped: 0 };
    // Checkpoint after every item: progress (e.g. photoUploaded) survives the
    // app being killed mid-flush, and completed items leave the queue at once.
    const checkpoint = async (outcomes: ItemOutcome[]) => {
      await writeOutbox(reconcileOutboxAfterFlush(await readOutbox(), outcomes));
    };
    return await flushOutboxItems(snapshot, { ...api, persist: checkpoint });
  } finally {
    flushing = false;
  }
}
