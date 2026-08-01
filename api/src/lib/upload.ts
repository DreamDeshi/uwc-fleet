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
 *   2. POD delivery URLs carry `f_auto` (lib/podPhotos.ts), which is only safe
 *      because a POD cannot be a PDF. f_auto on a PDF keeps page one and
 *      silently drops the rest.
 *
 * A convention that two safety properties rest on should be a check.
 */
export const IMAGE_MIMETYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
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
