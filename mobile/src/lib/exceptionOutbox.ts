import { scopedGetItem, scopedSetItem } from "./scopedStorage";
import {
  flushOutboxItems,
  mergeOutboxItem,
  reconcileOutboxAfterFlush,
  type ExceptionOutboxApi,
  type ExceptionOutboxItem,
  type FlushResult,
  type OutboxPatch,
} from "./exceptionOutboxCore";

// EXCEPTION OFFLINE OUTBOX — durable storage edge (AsyncStorage; localStorage on
// web) + change notification. All queue/replay LOGIC lives in the pure
// exceptionOutboxCore (unit-tested); the real API + triggers live in
// hooks/useExceptionOutbox.ts. Same layering as podOutbox.

export * from "./exceptionOutboxCore";

const OUTBOX_SUFFIX = "exceptionOutbox";

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribeExceptionOutbox(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((fn) => fn());
}

async function readOutbox(): Promise<ExceptionOutboxItem[]> {
  try {
    const raw = await scopedGetItem(OUTBOX_SUFFIX);
    return raw ? (JSON.parse(raw) as ExceptionOutboxItem[]) : [];
  } catch {
    return [];
  }
}
async function writeOutbox(items: ExceptionOutboxItem[]): Promise<void> {
  await scopedSetItem(OUTBOX_SUFFIX, JSON.stringify(items));
  notify();
}

export async function getExceptionOutbox(): Promise<ExceptionOutboxItem[]> {
  return readOutbox();
}

/** Queue (or merge) a report. Throws if storage fails so the caller can fall
 *  back to the normal error path rather than claim "saved". */
export async function enqueueExceptionReport(patch: OutboxPatch): Promise<void> {
  const items = await readOutbox();
  await writeOutbox(mergeOutboxItem(items, patch, new Date().toISOString()));
}

/** A DIRECT (online) report succeeded — drop any queued copy of the same
 *  occurrence so a later flush can't re-post it. */
export async function noteDirectReport(clientOccurrenceId: string): Promise<void> {
  const items = await readOutbox();
  if (!items.some((i) => i.clientOccurrenceId === clientOccurrenceId)) return;
  await writeOutbox(items.filter((i) => i.clientOccurrenceId !== clientOccurrenceId));
}

let flushing = false;
export async function flushExceptionOutbox(api: ExceptionOutboxApi): Promise<FlushResult> {
  if (flushing) return { outcomes: [], synced: 0, dropped: 0 };
  flushing = true;
  try {
    const snapshot = await readOutbox();
    if (snapshot.length === 0) return { outcomes: [], synced: 0, dropped: 0 };
    const result = await flushOutboxItems(snapshot, api);
    await writeOutbox(reconcileOutboxAfterFlush(await readOutbox(), result.outcomes));
    return result;
  } finally {
    flushing = false;
  }
}
