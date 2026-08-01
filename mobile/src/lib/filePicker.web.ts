/**
 * WEB half of the file-dialog split — a plain `<input type="file">`.
 *
 * ⚠ NO NEW DEPENDENCY, deliberately. `expo-document-picker` would do this too,
 * but it carries native code: installing it means a `runtimeVersion` bump, a
 * fresh EAS build and redistributing an APK to every driver. A file input is a
 * browser primitive, so requestor paperwork gains PDF support over the air while
 * the native side waits for a build that is worth making on its own.
 *
 * ⚠ IT MUST ALWAYS SETTLE. A file dialog the user closes without choosing fires
 * NO change event in several browsers, so the naive implementation leaves a
 * promise pending forever — indistinguishable, from the user's side, from the
 * "photo picked but nothing happens" bug this codebase has already shipped once.
 * Three independent paths resolve it: change, cancel, and a window-focus
 * fallback for browsers that support neither.
 */

export interface PickedFile {
  uri: string;
  name: string;
  type: string;
}

/** Matches the API's multer cap (lib/upload.ts) so the failure is legible here. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const FILE_DIALOG_SUPPORTED = true;

export const DOCUMENT_ACCEPT = "image/*,application/pdf";

/** How long to wait after focus returns before calling it a cancel. */
const CANCEL_GRACE_MS = 600;

export async function openFileDialog(accept: string): Promise<PickedFile | "too_large" | null> {
  if (typeof document === "undefined") return null;

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = false;
    // Off-screen rather than display:none — a hidden input is ignored by some
    // browsers' click() handling.
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);

    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      window.removeEventListener("focus", onFocus);
      if (focusTimer) clearTimeout(focusTimer);
      input.remove();
    };

    const done = (value: PickedFile | "too_large" | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    function onFocus() {
      // Focus returns to the window whether the user chose a file or cancelled,
      // and it arrives BEFORE change. Wait out the grace period; if change lands
      // first it settles the promise and this becomes a no-op.
      focusTimer = setTimeout(() => done(null), CANCEL_GRACE_MS);
    }

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      if (file.size > MAX_UPLOAD_BYTES) return done("too_large");
      done({
        uri: URL.createObjectURL(file),
        name: file.name || "upload",
        type: file.type || "application/octet-stream",
      });
    };

    // Supported in newer browsers; the focus fallback covers the rest.
    input.oncancel = () => done(null);

    window.addEventListener("focus", onFocus);
    input.click();
  });
}
