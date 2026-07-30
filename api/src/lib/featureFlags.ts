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

/**
 * Interplant pay — the A4 scheme (flat 1 point per completed round trip, no
 * deduction, per-truck interplant rates, P1–P9 fence). Off by default; enable
 * with FEATURE_INTERPLANT=true.
 *
 * Gated because turning it on CHANGES MONEY and changes booking. While off,
 * every path behaves exactly as it did before the feature existed: interplant
 * route types score per-zone like any other trip, the P1–P9 fence is not
 * applied, and the pickup point is ignored. That matters more than usual here —
 * an ungated first cut would have 400'd every interplant booking from the app,
 * and locked existing ones out of editing, because the requestor UI does not
 * send a pickup point yet.
 *
 * ⚠ DO NOT TURN THIS ON until Mr. Teh answers whether a round trip is ONE
 * booking with two legs or TWO bookings paid once between them. That answer
 * decides the data model, not just the arithmetic — see the note in
 * services/interplant.ts.
 */
export function interplantEnabled(): boolean {
  return process.env.FEATURE_INTERPLANT === "true";
}
