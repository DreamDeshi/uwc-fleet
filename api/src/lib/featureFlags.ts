// Runtime feature flags, read per-request (never cached) so a flag can be
// flipped without a redeploy of already-running code. All flags DEFAULT OFF:
// an unset / blank / non-"true" value is disabled, so a typo can never turn a
// feature on in production by accident.

/**
 * Failed-delivery / exception workflow (Phase 1). Off by default. Enable with
 * FEATURE_EXCEPTIONS=true. While off, the /trips/:id/exception* routes 404 as
 * if they do not exist, so the feature is invisible until deliberately turned on.
 */
export function exceptionsEnabled(): boolean {
  return process.env.FEATURE_EXCEPTIONS === "true";
}

/**
 * Request Change — the A19 approval flow for ASSIGNED bookings. Off by default.
 * Enable with FEATURE_CHANGE_REQUESTS=true.
 *
 * Gated because, unlike the rest of this batch, it changes REQUESTOR behaviour
 * the moment it deploys: an assigned booking gains a new button and a new way
 * for the office to be interrupted. While off, all four /change-request* routes
 * 404 as if they do not exist and the mobile surfaces are hidden, so the table
 * simply sits empty.
 */
export function changeRequestsEnabled(): boolean {
  return process.env.FEATURE_CHANGE_REQUESTS === "true";
}
