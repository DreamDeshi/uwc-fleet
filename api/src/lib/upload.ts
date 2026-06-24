import multer from "multer";

// In-memory storage so handlers can stream the buffer straight to Cloudinary
// without touching the (ephemeral) Railway filesystem. The mobile app already
// compresses POD photos to ≤500KB, but we cap at 10MB as a safety net for
// requestor-uploaded documents (invoices, scanned DOs).
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
