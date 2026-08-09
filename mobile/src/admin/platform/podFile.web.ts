// POD download / share — WEB build.
//
// ⚠ THE SIGNED URL CANNOT BE REWRITTEN. Cloudinary's `fl_attachment` flag would
// force a download in one line, but the POD delivery URL is SIGNED: appending a
// transformation invalidates the signature and the request 401s. So the file is
// fetched and handed to the browser as a blob instead. (The alternative — a
// server route that signs a `fl_attachment` URL — is an API change, and this
// had to ship as an OTA.)
//
// The `download` attribute is ALSO not an option on its own: browsers ignore it
// for cross-origin hrefs, so `<a download href={cloudinaryUrl}>` opens a tab
// rather than saving. Only a same-origin blob: URL honours it.

async function fetchAsBlob(url: string): Promise<Blob> {
  // Cloudinary serves delivery URLs with permissive CORS, but a signed URL that
  // has EXPIRED comes back 401 — surface that rather than saving an error page
  // as if it were a photo.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`POD fetch failed: ${res.status}`);
  return res.blob();
}

export async function downloadPod(url: string, filename: string): Promise<void> {
  const blob = await fetchAsBlob(url);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

/**
 * True only when the browser can share FILES. `navigator.share` alone is not
 * enough — desktop Chrome exposes it for text/URLs while refusing files, so
 * checking only `share` would offer a button that throws on click. The viewer
 * hides the button instead of shipping one that fails.
 */
export function canSharePod(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare !== "function") return false;
  try {
    const probe = new File([new Blob([""], { type: "image/jpeg" })], "probe.jpg", { type: "image/jpeg" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export async function sharePod(url: string, filename: string): Promise<void> {
  const blob = await fetchAsBlob(url);
  const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
  // Share the FILE, never the signed URL. A pasted URL is a live, unauthenticated
  // handle on private evidence until its signature lapses; a file is a copy the
  // recipient already has and cannot use to reach anything else.
  await navigator.share({ files: [file] });
}
