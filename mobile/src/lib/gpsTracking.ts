// Pure gate for the active-trip GPS tracker — what it should do given the
// trip-active flag and the driver's consent. Import-free so it's unit-testable
// in plain node (same discipline as podOutboxCore / the API's pure services).
//
// The privacy rule lives here: tracking only ever runs when the trip is active
// AND the driver has consented; anything else means NO location capture.
export type TrackingGate = "idle" | "needs_consent" | "active";

export function trackingGate(enabled: boolean, consented: boolean): TrackingGate {
  if (!enabled) return "idle"; // trip not in progress → never touch GPS
  if (!consented) return "needs_consent"; // active, but driver hasn't agreed yet
  return "active"; // active + consented → request permission + track
}
