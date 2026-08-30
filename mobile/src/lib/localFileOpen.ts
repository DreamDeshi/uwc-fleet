// Open a LOCAL file (picked but not yet uploaded) for the user to check —
// NATIVE build (the web build resolves localFileOpen.web.ts).
//
// ⚠ `Linking.openURL` cannot be used for this: a `file://` URI from one app's
// sandbox is not readable by whatever app Android hands it to, so the OS
// intent silently fails on modern Android. `expo-sharing`'s share sheet is
// the same escape hatch `admin/platform/podFile.ts` already uses for exactly
// this reason — the user picks "Preview"/"Files"/any PDF-capable app, and
// the OS (not this app) handles the file type.
//
// ⚠ THIS NEEDS A BINARY THAT CONTAINS expo-sharing (runtimeVersion 1.1.0+,
// same as podFile.ts) — not a new native module, the same one already in the
// currently-published runtime.
import * as Sharing from "expo-sharing";

export async function openLocalFile(uri: string, opts: { mimeType?: string; dialogTitle?: string }): Promise<void> {
  await Sharing.shareAsync(uri, { mimeType: opts.mimeType, dialogTitle: opts.dialogTitle });
}
