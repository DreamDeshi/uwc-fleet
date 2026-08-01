import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";

/**
 * NATIVE image compression. The web twin is imageCompress.web.ts and the two
 * MUST agree on the contract below — Metro picks one by platform and nothing
 * else in the app knows which it got.
 *
 * CONTRACT (both platforms):
 *   • Resize to TARGET_WIDTH, re-encode JPEG, step quality down until the file
 *     is under MAX_BYTES.
 *   • NEVER THROW, NEVER HANG. On any failure return the ORIGINAL uri.
 *
 * ⚠ The fail-open rule is the important half. Compression is an optimisation;
 * a POD photo is the gate on Delivered and therefore on pay. A driver at a
 * dropoff must never be blocked because an image library misbehaved — the same
 * reasoning as the customs-document gate, which fails open for exactly this
 * reason ("a missing document is recoverable at POD approval; a stranded driver
 * isn't"). Before this module the native path had no try/catch at all, so a
 * manipulateAsync failure propagated out of capturePodPhoto and killed the
 * capture outright.
 */

export const TARGET_WIDTH = 1280;
export const MAX_BYTES = 500 * 1024;

const QUALITY_START = 0.7;
const QUALITY_FLOOR = 0.2;
const QUALITY_STEP = 0.15;
const MAX_ATTEMPTS = 4;

/**
 * Resize then step down JPEG quality until the file is under the limit. Most
 * phone photos land under MAX_BYTES after the first pass; the loop is a safety
 * net for very large originals.
 */
export async function compressToLimit(uri: string): Promise<string> {
  try {
    let quality = QUALITY_START;
    let out = await manipulateAsync(uri, [{ resize: { width: TARGET_WIDTH } }], {
      compress: quality,
      format: SaveFormat.JPEG,
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const size = fileSize(out.uri);
      if (size === null || size <= MAX_BYTES) break;
      quality = Math.max(quality - QUALITY_STEP, QUALITY_FLOOR);
      out = await manipulateAsync(uri, [{ resize: { width: TARGET_WIDTH } }], {
        compress: quality,
        format: SaveFormat.JPEG,
      });
    }

    return out.uri;
  } catch {
    // Fail open — see the contract above. An uncompressed upload still works;
    // a blocked capture does not.
    return uri;
  }
}

function fileSize(uri: string): number | null {
  try {
    return new File(uri).size ?? null;
  } catch {
    return null;
  }
}
