import type { PasswordResetRequestStatus } from "@prisma/client";

/**
 * Self-service password reset request — shared logic between the public
 * create route (routes/auth.ts), the admin queue (routes/passwordReset
 * Requests.ts) and the login route's auto-close.
 *
 * Owner-approved design, 20 Aug 2026: the requester picks their OWN new
 * password at request time; the server stores only its bcrypt hash; an admin
 * verifies identity and approves, which promotes the hash onto
 * User.password_hash. Nothing is ever transmitted.
 */

/** A pending request older than this reads as "expired" — see the schema
 *  comment on PasswordResetRequestStatus for why this is never a stored
 *  value. 24 hours, per the approved design. */
export const PASSWORD_RESET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export type EffectivePasswordResetStatus = PasswordResetRequestStatus | "expired";

/**
 * TIME-DERIVED, never written. A request is only ever "expired" from a
 * reader's point of view — the row itself stays "pending" until something
 * actually resolves it (approve/dismiss/login-close), so this must be
 * recomputed on every read rather than trusted from a stale value.
 */
export function isPasswordResetRequestExpired(
  request: { status: PasswordResetRequestStatus; requested_at: Date },
  now: Date
): boolean {
  return (
    request.status === "pending" &&
    now.getTime() - request.requested_at.getTime() > PASSWORD_RESET_REQUEST_TTL_MS
  );
}

/** The status a client should be shown — "expired" overrides a DB-stored
 *  "pending" once the TTL has passed; every other status passes through. */
export function effectivePasswordResetStatus(
  request: { status: PasswordResetRequestStatus; requested_at: Date },
  now: Date
): EffectivePasswordResetStatus {
  return isPasswordResetRequestExpired(request, now) ? "expired" : request.status;
}

/**
 * The CAS where-clause an approve/dismiss route's updateMany must use: only a
 * request that is still genuinely pending (status="pending" AND not past the
 * TTL) may be claimed. Folding the expiry into the WHERE, rather than
 * checking it separately after a read, closes the TOCTOU a
 * read-then-write pair would leave — the row can only be claimed atomically.
 */
export function claimablePasswordResetRequestWhere(now: Date) {
  return {
    status: "pending" as const,
    requested_at: { gte: new Date(now.getTime() - PASSWORD_RESET_REQUEST_TTL_MS) },
  };
}
