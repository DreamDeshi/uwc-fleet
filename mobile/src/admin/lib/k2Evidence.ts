/**
 * What the approving admin should be told about a stop's Borang K2 (IM9).
 *
 * Mr. Teh, R1 Q6: *"Prefer they need upload the form … we need admin to final
 * validate and approve, only they can get pay."* The upload half shipped on
 * 25 Jul and gates Delivered. The VALIDATE half did not exist as a screen — no
 * surface in the admin app rendered `k2_photo` at all, so an admin approving
 * pay for a Bayan Lepas stop was approving a document nobody had ever looked
 * at. The server deliberately never inspects it either (R3 A12: "any document
 * will do"), which makes this screen the ONLY point where a human sees it.
 *
 * Pure rules, no React — same split as lib/uploadTypes.ts, so the states can be
 * tested without rendering the approval queue.
 */
import { requiresCustomsDoc } from "../../lib/activeTripStage";

export type K2Evidence =
  /** No customs document is expected here, and none was uploaded. Show nothing. */
  | "not_required"
  /** A document exists and can be opened. */
  | "present"
  /** This stop's area demands one and there isn't one. */
  | "missing";

/** The fields this decision reads — structural, so both TripStop shapes fit. */
export interface K2StopLike {
  k2_photo?: string | null;
  consignee: { zone_code?: string | null; area?: string | null };
}

/**
 * ⚠ PRESENCE WINS OVER THE ZONE RULE. The `requiresCustomsDoc` test is asked
 * SECOND, and only to explain an absence.
 *
 * Gating the link on the zone rule instead would mean a document that exists
 * but sits outside the expected area is silently unviewable — the admin would
 * have no idea it was ever uploaded. That is the same class of bug this whole
 * item exists to fix, reintroduced one level down. The rule also moved once
 * already (29 Jul: zone P1 → the Bayan Lepas AREA inside it), so anything
 * uploaded under the older reading is exactly the kind of row that would
 * disappear.
 *
 * A stored document is a fact; the zone rule is a prediction. Trust the fact.
 */
export function k2Evidence(stop: K2StopLike): K2Evidence {
  if (stop.k2_photo) return "present";
  if (requiresCustomsDoc(stop.consignee.zone_code, stop.consignee.area)) return "missing";
  return "not_required";
}
