import { createHash } from "node:crypto";

// SERVER-computed content identities for payload-sensitive idempotency. All hashes
// are derived here, on the server, from NORMALIZED values and the raw uploaded
// photo bytes — a client-supplied digest is never trusted.

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Canonicalize a value into the fingerprint string: null/undefined → "", Date →
// ISO, everything else → String(). A JSON array of canonical parts is hashed, so
// field order is fixed and ambiguity (e.g. "1"+"23" vs "12"+"3") is impossible.
function canon(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function digest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts.map(canon))).digest("hex");
}

export interface ReportFingerprintInput {
  tripId: string;
  tripStopId: string | null;
  category: string;
  reason: string;
  reportedBy: string;
  clientActionId: string;
  clientEvidenceId: string;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  clientReportedAt: Date | null;
  capturedClientAt: Date | null;
  photoSha256: string;
}

/** Fingerprint over EVERY semantically relevant report input + the photo's byte
 *  digest. A reused client_occurrence_id whose recomputed fingerprint differs is a
 *  payload change (409); an identical one is a genuine replay. */
export function reportFingerprint(i: ReportFingerprintInput): string {
  return digest([
    "report",
    i.tripId,
    i.tripStopId,
    i.category,
    i.reason,
    i.reportedBy,
    i.clientActionId,
    i.clientEvidenceId,
    i.lat,
    i.lng,
    i.accuracyM,
    i.clientReportedAt,
    i.capturedClientAt,
    i.photoSha256,
  ]);
}

export interface EvidenceIdentityInput {
  exceptionId: string;
  kind: string;
  uploadedBy: string;
  capturedClientAt: Date | null;
  photoSha256: string;
}

/** Fingerprint over the immutable evidence identity — exception + kind + uploader
 *  + capture time + photo byte digest. Same evidence UUID with any of these
 *  changed is a reuse (409). */
export function evidenceFingerprint(i: EvidenceIdentityInput): string {
  return digest(["evidence", i.exceptionId, i.kind, i.uploadedBy, i.capturedClientAt, i.photoSha256]);
}
