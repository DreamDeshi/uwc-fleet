// POD download / share — NATIVE build (the web build resolves podFile.web.ts).
//
// ⚠ THIS NEEDS A BINARY THAT CONTAINS expo-sharing. It arrived with the
// runtimeVersion 1.1.0 rebuild; an OTA cannot deliver native code, so an older
// APK running this JS would crash on the import. That is exactly what
// runtimeVersion gates — 1.0.0 binaries never receive 1.1.0 bundles.
//
// ⚠ A POD saved or shared from here LEAVES THE APP'S ACCESS CONTROLS for good:
// no expiry, no audit trail, and it outlives the signed URL it came from. The
// owner cleared that policy on 9 Aug 2026.
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

/**
 * Pull the signed URL down to a cache file first. The share sheet needs a
 * file:// URI — handing it the https URL would share a LINK, and a signed POD
 * URL is a live, unauthenticated handle on private evidence until it lapses.
 */
async function cachePod(url: string, filename: string): Promise<string> {
  // expo-file-system 19 API: the legacy downloadAsync/cacheDirectory pair is
  // gone, replaced by File/Paths. Paths.cache is a Directory, and
  // File.downloadFileAsync resolves to the written File.
  const target = new File(Paths.cache, filename);
  // Overwrite rather than accumulate: the same POD opened twice would otherwise
  // collide, and the cache is the OS's to clear anyway.
  if (target.exists) target.delete();
  const written = await File.downloadFileAsync(url, target);
  // An EXPIRED signature comes back 401 with a body — without a size check the
  // error page is cached and shared as if it were the photo.
  if (!written.exists || (written.size ?? 0) === 0) throw new Error("POD download failed or was empty");
  return written.uri;
}

export async function downloadPod(url: string, filename: string): Promise<void> {
  // There is no "save to Downloads" on iOS and no gallery write without a
  // media-library permission, so on native the share sheet IS the save action:
  // it offers Files / Photos / anywhere else the OS allows.
  const uri = await cachePod(url, filename);
  await Sharing.shareAsync(uri, { mimeType: "image/jpeg", dialogTitle: filename });
}

export async function sharePod(url: string, filename: string): Promise<void> {
  const uri = await cachePod(url, filename);
  await Sharing.shareAsync(uri, { mimeType: "image/jpeg", dialogTitle: filename });
}

/** Whether a share sheet exists. Some Android builds genuinely lack one. */
export function canSharePod(): boolean {
  // isAvailableAsync is async and this is called during render; the module is
  // present in this binary by construction (see the header), so the honest
  // answer here is yes, and shareAsync surfaces any real failure at press time.
  return true;
}
