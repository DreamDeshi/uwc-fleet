import { scopedGetItem, scopedSetItem } from "./scopedStorage";
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

const OUTBOX_SUFFIX = "podOutbox";

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

const CORRUPT_SUFFIX_PREFIX = "podOutbox.corrupt";

/** Keep unparseable bytes instead of destroying them. Best effort by design. */
async function quarantineCorrupt(raw: string): Promise<void> {
  try {
    await scopedSetItem(`${CORRUPT_SUFFIX_PREFIX}.${Date.now()}`, raw);
  } catch {
    // Storage is already misbehaving; failing to quarantine must not also block
    // the driver from queueing the delivery in front of them.
  }
}

async function readOutboxOutcome(): Promise<ReadOutcome> {
  let raw: string | null;
  try {
    raw = await scopedGetItem(OUTBOX_SUFFIX);
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

// ── ERASE GUARD — an empty write must be a CONCLUSION, not an absence ─────
//
// One shape has now produced three separate defects: something reads nothing,
// concludes there is nothing, and writes that conclusion back over real work.
// Twice in this file's own read path (a storage failure and a corrupt value
// both collapsing to `[]`), once in the storage refactor beside it. Each was
// fixed where it happened, and each fix left the NEXT caller free to do it
// again — including callers nobody has written yet.
//
// So the module refuses instead. An empty write is performed only for items the
// writer can NAME. A caller that read nothing has nothing to name, so it cannot
// empty the queue, whatever the reason it read nothing: an unset user pointer, a
// storage error, a flush racing sign-in, a future mistake of a kind not yet
// invented. The guard sits below every writer rather than inside any of them,
// which is the difference between fixing an instance and closing a shape.
//
// SCOPE — the empty case only, on purpose. The general form ("account for every
// item that disappears") would also have to account for the MAX_OUTBOX trim in
// mergeOutboxItem, which drops the oldest item deliberately; making enqueue
// declare that would put this guard in the path of the one operation a driver
// cannot afford to have refused. Emptying is the shape that has actually bitten,
// and it is the one that costs a day of deliveries rather than one stop.

/** Items the writer positively accounted for: synced, dropped, or completed online. */
interface WriteAccount {
  resolved: readonly PodOutboxItem[];
}

/** The default is to name NOTHING — so an unthinking caller cannot empty a queue. */
const ACCOUNTS_FOR_NOTHING: WriteAccount = { resolved: [] };

/** stopId alone is not identity: an item re-queued mid-flush is a different intent. */
const itemKey = (i: PodOutboxItem) => `${i.stopId}|${i.queuedAt}`;

export const ERASE_REFUSED = "POD outbox: refusing to empty a queue the caller cannot account for";

/**
 * What is stored, WITHOUT side effects. Deliberately not `readOutboxOutcome`:
 * that quarantines corrupt bytes, and a guard that mutates storage is a guard
 * that can cause the damage it exists to prevent.
 */
async function peekStoredItems(): Promise<PodOutboxItem[] | "unreadable"> {
  let raw: string | null;
  try {
    raw = await scopedGetItem(OUTBOX_SUFFIX);
  } catch {
    return "unreadable";
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PodOutboxItem[];
  } catch {
    // Unparseable: there is no readable queue to protect, and the write path
    // (readOutboxOutcome) has already quarantined the raw bytes.
  }
  return [];
}

async function assertEraseIsAccountedFor(account: WriteAccount): Promise<void> {
  // Logged HERE rather than at the call sites. Callers swallow or propagate a
  // refusal differently — the flush's does not surface at all — and a guard
  // whose only evidence is "the data is still there" cannot be told apart from
  // a guard that never ran. That indistinguishability is precisely how this
  // shape survived three fixes. One place they all pass through, one log.
  const refuse = (why: string): never => {
    const message = `${ERASE_REFUSED} — ${why}`;
    console.warn(`podOutbox: ${message}`);
    throw new Error(message);
  };

  const stored = await peekStoredItems();
  // Unreadable is the exact state the original bug fired in: we cannot see what
  // we would be destroying, so we do not destroy it.
  if (stored === "unreadable") refuse("storage unreadable, cannot see what would be lost");
  const named = new Set(account.resolved.map(itemKey));
  const unaccounted = (stored as PodOutboxItem[]).filter((i) => !named.has(itemKey(i)));
  if (unaccounted.length > 0) {
    refuse(
      `${unaccounted.length} queued item(s) the writer never saw: ` +
        unaccounted.map((i) => i.stopId).join(", ")
    );
  }
}

// Write errors (e.g. web localStorage quota) PROPAGATE: the caller must fall
// back to the normal error path rather than telling the driver "saved" when
// nothing was.
//
// ⚠ THE ONLY WRITER. Nothing else in this module may call scopedSetItem with
// OUTBOX_SUFFIX — a second writer is a second way past the erase guard, and a
// test asserts there isn't one.
async function writeOutbox(
  items: PodOutboxItem[],
  account: WriteAccount = ACCOUNTS_FOR_NOTHING
): Promise<void> {
  if (items.length === 0) await assertEraseIsAccountedFor(account);
  await scopedSetItem(OUTBOX_SUFFIX, JSON.stringify(items));
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
  const resolved = outcome.items.filter((i) => i.stopId === stopId);
  if (resolved.length === 0) return;
  await tidyUp(
    outcome.items.filter((i) => i.stopId !== stopId),
    resolved
  );
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
    await tidyUp(items.filter((i) => i.stopId !== stopId), [item]);
    return;
  }
  await writeOutbox(
    items.map((i) => (i.stopId === stopId ? { ...i, photo: null, photoUploaded: true } : i))
  );
}

/**
 * A post-success tidy-up: the stop is already finished server-side, so this
 * write is housekeeping, not the delivery. If the erase guard refuses it,
 * something was queued between our read and our write — refusing is CORRECT
 * (that item would have been destroyed) and the stale entry we meant to drop
 * replays idempotently. Warn rather than throw: the driver has nothing to do
 * about it, and turning housekeeping into an error toast after a successful
 * delivery would teach them to distrust the successful ones. (The refusal is
 * already logged by the guard itself, so swallowing it here is not silence.)
 */
async function tidyUp(items: PodOutboxItem[], resolved: PodOutboxItem[]): Promise<void> {
  try {
    await writeOutbox(items, { resolved });
  } catch (err) {
    if (!String((err as Error)?.message).startsWith(ERASE_REFUSED)) throw err;
  }
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
      // What the flush actually SETTLED. "kept" is not settled — an item the
      // server never accepted must not license emptying the queue.
      const resolved = outcomes.filter((o) => o.outcome !== "kept").map((o) => o.item);
      await writeOutbox(reconcileOutboxAfterFlush(current.items, outcomes), { resolved });
    };
    return await flushOutboxItems(snapshot, { ...api, persist: checkpoint }, opts);
  } finally {
    flushing = false;
  }
}
