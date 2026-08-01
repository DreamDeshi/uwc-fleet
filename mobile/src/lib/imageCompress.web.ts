/**
 * WEB image compression — the twin of imageCompress.ts. Read that file's
 * CONTRACT block first; both platforms must honour it identically.
 *
 * ⚠ WHY THIS EXISTS AT ALL. Until now finalizePhoto skipped compression on web
 * entirely, so a photo taken through the browser build uploaded the camera
 * ORIGINAL — 2-5MB against ~200KB for the same shot through the APK, a 10-25x
 * multiplier on every byte stored and delivered. That skip was not an oversight:
 * expo-image-manipulator and expo-file-system are unreliable in the browser and
 * removing them fixed the "photo picked but nothing happens" bug. So this
 * implementation uses NOTHING from Expo — only Canvas, which is a browser-native
 * API and cannot reintroduce that failure.
 *
 * ⚠ It is also written so it can never hang. The original bug was a silent
 * non-event at the picker, and a promise that never settles would look exactly
 * the same to a driver. Every await here is bounded by LOAD_TIMEOUT_MS and every
 * failure path returns the untouched uri.
 */

export const TARGET_WIDTH = 1280;
export const MAX_BYTES = 500 * 1024;

const QUALITY_START = 0.7;
const QUALITY_FLOOR = 0.2;
const QUALITY_STEP = 0.15;
const MAX_ATTEMPTS = 4;
const LOAD_TIMEOUT_MS = 10_000;

export async function compressToLimit(uri: string): Promise<string> {
  try {
    const img = await loadImage(uri);

    // Never upscale: a small original stays its own size. Scaling a 400px
    // photo up to 1280 would grow the file while destroying nothing but disk.
    const scale = img.width > TARGET_WIDTH ? TARGET_WIDTH / img.width : 1;
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return uri;
    ctx.drawImage(img, 0, 0, width, height);

    let quality = QUALITY_START;
    let out = canvas.toDataURL("image/jpeg", quality);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (dataUrlBytes(out) <= MAX_BYTES) break;
      quality = Math.max(quality - QUALITY_STEP, QUALITY_FLOOR);
      out = canvas.toDataURL("image/jpeg", quality);
    }

    // A data: uri rather than an object URL, deliberately: fetch() accepts both
    // (queries.appendPhoto turns it into a Blob), but a data: uri also survives
    // a page reload, which is what toDurablePhotoUri exists to guarantee for the
    // offline outbox. Returning data: makes that conversion a no-op.
    return out;
  } catch {
    // Fail open — an uncompressed upload still works; a blocked capture does not.
    return uri;
  }
}

/** Bytes behind a base64 data: uri, without materialising the buffer. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const b64 = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
  return Math.floor((b64 * 3) / 4) - padding;
}

/**
 * Resolve an <img> for a blob:/data: uri. Rejects on error AND on timeout —
 * a decode that never completes must not become an upload that never starts.
 */
function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = img.onerror = null;
      reject(new Error("image decode timed out"));
    }, LOAD_TIMEOUT_MS);

    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("image failed to decode"));
    };
    img.src = uri;
  });
}
