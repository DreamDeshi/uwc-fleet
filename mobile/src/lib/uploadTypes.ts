/**
 * Pure rules about uploaded file types. No React Native, no Expo, no platform
 * split — so the decision that protects multi-page documents can be tested
 * directly rather than through three layers of mocks.
 */

/**
 * May this file be re-encoded before upload?
 *
 * ⚠ ONLY IMAGES. A PDF must reach the server byte-for-byte: re-encoding one is
 * exactly how pages get dropped, and paperwork — customs forms, invoices — is
 * the class of document that runs to several. The server refuses to
 * format-convert a K2 for the same reason (lib/podPhotos.ts, signedK2Url).
 *
 * Unknown or empty types are NOT compressible: the compressor would fail open
 * and hand the original back anyway, but deciding "leave it alone" here means
 * the file also keeps its declared name and type instead of being relabelled a
 * JPEG on a guess.
 */
export function isCompressibleType(mimetype: string | undefined | null): boolean {
  return (mimetype ?? "").toLowerCase().trim().startsWith("image/");
}

/**
 * Rename a file that has been re-encoded to JPEG.
 *
 * The extension is not cosmetic: Cloudinary records the asset's format from it,
 * and the requestor's paperwork row reads that format back off the delivery URL
 * to decide whether to render a thumbnail. A re-encoded `scan.png` that kept its
 * name would be stored as a PNG that is really a JPEG.
 */
export function asJpgName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  return `${stem || "document"}.jpg`;
}
