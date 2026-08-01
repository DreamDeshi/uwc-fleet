/**
 * NATIVE half of the file-dialog split. There is no native file dialog in this
 * app: `expo-image-picker` cannot select a PDF, and no document picker is
 * installed — adding one means a new native module, a `runtimeVersion` bump and
 * a fresh APK to every driver, which is a deliberate separate decision.
 *
 * So this returns null and advertises FILE_DIALOG_SUPPORTED = false. Callers
 * fall back to the image picker, which is exactly today's behaviour.
 *
 * ⚠ `null` alone is ambiguous — on web it means "the user cancelled". Callers
 * MUST read FILE_DIALOG_SUPPORTED to tell the two apart, or a cancelled web
 * dialog would silently reopen as an image picker.
 */

export interface PickedFile {
  uri: string;
  name: string;
  type: string;
}

/** Matches the API's multer cap (lib/upload.ts). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const FILE_DIALOG_SUPPORTED = false;

export const DOCUMENT_ACCEPT = "image/*,application/pdf";

export async function openFileDialog(_accept: string): Promise<PickedFile | "too_large" | null> {
  return null;
}
