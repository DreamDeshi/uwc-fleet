import multer from "multer";
import { ApiError } from "./apiError";

// In-memory storage so handlers can stream the buffer straight to Cloudinary
// without touching the (ephemeral) Railway filesystem. The mobile app already
// compresses POD photos to ≤500KB, but we cap at 10MB as a safety net for
// requestor-uploaded documents (invoices, scanned DOs).
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * WHAT EACH UPLOAD ROUTE WILL ACCEPT — enforced on the SERVER, not left to the
 * client picker.
 *
 * ⚠ This distinction is the point of the module. "POD is always a camera photo"
 * used to be true only because every picker in the app was configured
 * `mediaTypes: ["images"]` — a convention, holding across four call sites, with
 * nothing stopping a direct POST. Two things now depend on it being a fact:
 *
 *   1. Owner ruling (1 Aug 2026): POD and exception evidence are proof that
 *      something happened LIVE at the delivery point. POD gates pay, so letting
 *      an arbitrary file stand in for a live photo weakens the guarantee the
 *      photo exists to provide.
 *      ⚠ THIS IS A RULING ABOUT THE MEDIUM, NOT THE CLIENT'S DEFINITION OF A
 *      POD. Mr. Teh's workbook (TEST QUERY item 9, repeated in the 16 Jul
 *      email) calls the POD "the chop sign return copy on DO from consignee
 *      warehouse" — a DOCUMENT, which drivers happen to photograph. Nothing
 *      breaks today because every picker is images-only, but if UWC ever
 *      scans that chop-signed DO to PDF this rule 400s the pay gate. Re-open
 *      the decision then; do not read this comment as the client's own rule.
 *   2. POD delivery URLs carry `f_auto` (lib/podPhotos.ts), which is only safe
 *      because a POD cannot be a PDF. f_auto on a PDF keeps page one and
 *      silently drops the rest.
 *
 * A convention that two safety properties rest on should be a check.
 */
/**
 * ⚠ KEEP IN STEP WITH OPTIMISABLE_FORMATS in lib/podPhotos.ts. The two lists
 * describe the same thing — "a raster image this system expects to hold" — and
 * they disagreed on first writing: this one omitted bmp/tiff/avif while the
 * other listed them. Being too NARROW here is the dangerous direction: a POD
 * rejected on mimetype is not retryable, and the offline outbox drops an item
 * after 5 API failures, taking the queued photo and its delivery confirm with
 * it (OPEN_ITEMS DG-D4). A file type nobody expected costs a wasted upload;
 * a legitimate one costs the evidence.
 */
export const IMAGE_MIMETYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/avif",
] as const;

/** Paperwork may also be a PDF: customs forms and invoices arrive that way. */
export const DOCUMENT_MIMETYPES = [...IMAGE_MIMETYPES, "application/pdf"] as const;

/**
 * Reject a file whose type this route does not accept.
 *
 * Deliberately an ALLOWLIST and deliberately case-insensitive — a client that
 * sends "IMAGE/JPEG" is not an attacker, and a type nobody anticipated must not
 * pass because it wasn't on a denylist somebody forgot to update.
 */
export function assertMimetype(
  file: { mimetype?: string; originalname?: string } | undefined,
  allowed: readonly string[],
  what: string
): void {
  const mimetype = (file?.mimetype ?? "").toLowerCase().trim();
  if (allowed.includes(mimetype)) return;

  const wantsPdf = allowed.includes("application/pdf");
  throw new ApiError(
    400,
    "UNSUPPORTED_FILE_TYPE",
    wantsPdf
      ? `${what} must be a photo or a PDF.`
      : `${what} must be a photo taken at the delivery point.`
  );
}
