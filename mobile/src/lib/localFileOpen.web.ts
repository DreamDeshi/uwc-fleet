// Open a LOCAL file (picked but not yet uploaded) for the user to check —
// WEB build. `uri` is already a blob:/data: URL from the file picker, so no
// fetch/cache step is needed (unlike podFile.web.ts, which starts from a
// remote signed URL) — the browser's own tab handles an image or a PDF
// natively either way.
export async function openLocalFile(uri: string, _opts: { mimeType?: string; dialogTitle?: string }): Promise<void> {
  window.open(uri, "_blank", "noopener");
}
