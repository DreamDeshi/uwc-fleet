// POD download / share — NATIVE stub (the web build resolves podFile.web.ts).
//
// Same shape as csvShare.ts and stubbed for the same reason: a real native
// implementation needs expo-sharing plus a media-library permission, which is a
// NEW NATIVE DEPENDENCY and therefore an APK rebuild — it cannot ride an OTA.
// The viewer gates both buttons behind Platform.OS === "web", exactly as the
// Reports and Sustainability screens gate their CSV exports, so nothing calls
// this today. It exists so the web file has a counterpart to resolve against.
//
// ⚠ When this is filled in, a POD saved to the device gallery leaves the app's
// access controls behind for good: no expiry, no audit trail, and it will
// outlive the signed URL it came from. The owner cleared the policy on
// 9 Aug 2026; the practical consequence still belongs in the release note.
export async function downloadPod(_url: string, _filename: string): Promise<void> {
  throw new Error("POD download on native needs expo-sharing (APK rebuild), not an OTA.");
}

export async function sharePod(_url: string, _filename: string): Promise<void> {
  throw new Error("POD share on native needs expo-sharing (APK rebuild), not an OTA.");
}

/** Whether a share sheet exists on this platform. Native: not until the rebuild. */
export function canSharePod(): boolean {
  return false;
}
