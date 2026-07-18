/**
 * Stateless, unguessable tracking tokens for the public delivery-tracking link.
 *
 * A token is `<tripId>.<hmac>` where the HMAC is over the trip id with a server
 * secret — so anyone with the link can view that ONE trip's read-only status,
 * but the ids can't be enumerated and nothing is stored (no schema column). The
 * public route exposes only non-sensitive status (see routes/public).
 */
import crypto from "crypto";

// Dedicated secret if set, else the access-JWT secret (present in prod), else a
// dev-only default. A tracking token is low-sensitivity (read-only status), but
// it must still be unforgeable, so it is HMAC-signed like any other capability.
function secret(): string {
  return process.env.TRACKING_SECRET || process.env.JWT_ACCESS_SECRET || "uwc-dev-tracking-secret";
}

function sign(tripId: string): string {
  return crypto.createHmac("sha256", secret()).update(tripId).digest("base64url");
}

export function signTrackingToken(tripId: string): string {
  return `${tripId}.${sign(tripId)}`;
}

/** Return the trip id iff the token is well-formed and its signature matches; else null. */
export function verifyTrackingToken(token: string): string | null {
  const dot = token.lastIndexOf("."); // cuid ids contain no ".", so this splits cleanly
  if (dot <= 0) return null;
  const tripId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(tripId);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return tripId;
}
