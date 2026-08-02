/**
 * Durable storage for POD photos waiting in the offline outbox.
 *
 * ── THE BUG THIS EXISTS TO FIX ──────────────────────────────────────────────
 * `expo-image-picker` writes a capture into the app's CACHE directory, and the
 * outbox queued that `file://` URI as-is. Android is free to evict the cache
 * whenever the device runs low on storage — and it does so without touching
 * AsyncStorage, where the outbox entry itself lives. So the queue kept a
 * perfectly valid-looking entry pointing at a file that no longer existed.
 *
 * The driver did the work. The photo is gone. The flush then fails, burns its
 * five attempts (MAX_API_FAILURES) and DROPS the delivery — silent loss of the
 * evidence that gates his pay, on exactly the phone most likely to be short of
 * storage. Copying into the document directory, which the OS does not reclaim,
 * is the whole fix.
 *
 * ⚠ EVERY FUNCTION HERE FAILS OPEN. A copy that throws returns the original
 * cache URI: that is no worse than the behaviour being replaced, whereas
 * letting the error escape would refuse to queue the delivery at all and lose
 * it outright. Storage housekeeping must never be the reason a driver's stop
 * cannot be saved.
 */
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";

/** Sub-directory of the document directory holding queued POD captures. */
export const POD_PHOTO_DIR = "pod-outbox";

/** Web queues a `data:` URI, which is already durable across reloads. */
function isNativeFileUri(uri: string): boolean {
  return Platform.OS !== "web" && uri.startsWith("file://");
}

function podDir(): Directory {
  return new Directory(Paths.document, POD_PHOTO_DIR);
}

/**
 * Copy a freshly-captured photo somewhere the OS will not reclaim, and return
 * the URI to queue. Returns the input unchanged on web, for a non-file URI, or
 * if anything goes wrong.
 *
 * `now` is passed in rather than read here so the filename is deterministic in
 * tests — the same reason the outbox core takes its timestamps as arguments.
 */
export function persistPodPhoto(uri: string, stopId: string, now: number): string {
  if (!isNativeFileUri(uri)) return uri;
  try {
    const dir = podDir();
    if (!dir.exists) dir.create({ intermediates: true });

    const src = new File(uri);
    // Already gone (the exact eviction this module prevents) — nothing to copy.
    // Keep the original URI so the flush surfaces the real failure rather than
    // a confusing one about a destination that was never written.
    if (!src.exists) return uri;

    // stopId + timestamp: one live photo per stop, and a RETAKE gets a new name
    // rather than racing the old file. The sweep collects the superseded one.
    const dest = new File(dir, `${stopId}-${now}${src.extension || ".jpg"}`);
    if (dest.exists) dest.delete();
    src.copy(dest);
    return dest.uri;
  } catch {
    return uri;
  }
}

/**
 * Delete any stored photo the outbox no longer references.
 *
 * Called after every outbox write, which is what makes it correct without
 * threading a delete through each individual path (synced, dropped, retaken,
 * superseded by a direct upload). The list being written IS the set of live
 * references, so anything else on disk is genuinely an orphan.
 *
 * Without this the directory would grow forever — the document directory is
 * durable precisely because the OS will not clean it up for us.
 */
export function sweepPodPhotos(referencedUris: readonly string[]): void {
  if (Platform.OS === "web") return;
  try {
    const dir = podDir();
    if (!dir.exists) return;
    const keep = new Set(referencedUris);
    for (const entry of dir.list()) {
      if (entry instanceof File && !keep.has(entry.uri)) entry.delete();
    }
  } catch {
    // Best effort. A leaked file costs disk; a throw here would break the write
    // that just saved a driver's delivery.
  }
}
