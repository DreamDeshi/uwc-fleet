-- Server-computed content-identity columns for payload-sensitive idempotency
-- (additive, nullable). request_fingerprint = SHA-256 over normalized report
-- inputs + photo digest; content_sha256 = SHA-256 of the uploaded photo bytes.
ALTER TABLE "TripException" ADD COLUMN "request_fingerprint" TEXT;
ALTER TABLE "ExceptionEvidence" ADD COLUMN "content_sha256" TEXT;
