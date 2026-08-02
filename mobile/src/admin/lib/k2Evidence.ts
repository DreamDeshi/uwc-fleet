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
import { isStopSettled, type SettleableStop } from "../../lib/stopSettled";

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

export interface K2GateStop extends K2StopLike, SettleableStop {}

export interface K2ApprovalGaps<T> {
  /**
   * DELIVERED with the required document absent. Marking a stop delivered is
   * exactly what the upload gate stands in front of, so this combination should
   * be unreachable — it means either a pre-25-Jul row or a gate that did not
   * run. Blocks Approve behind a confirm.
   */
  blocking: T[];
  /**
   * Paid WITHOUT a delivery confirm (R3 Q11(a) — reached, admin verified +
   * resumed). The upload gate never ran, so no K2 was ever required and none is
   * "missing". NEVER blocks; carried only so the confirm can name the
   * difference instead of leaving the admin to guess which stops it means.
   */
  notExpected: T[];
}

/**
 * Split a trip's stops into the K2 absences that matter and the ones that do
 * not (owner ruling, 2 Aug 2026).
 *
 * ⚠ THE TWO CASES LOOK IDENTICAL IN THE DATA — both are a paid stop in a
 * Bayan Lepas area with no `k2_photo` — and they mean opposite things. The
 * discriminator is `status === "delivered"`, i.e. whether the upload gate was
 * ever in the driver's path. Collapsing them into one "K2 missing" test would
 * either block approvals that are perfectly correct (settled-undelivered) or
 * wave through the one anomaly worth stopping for.
 */
export function k2ApprovalGaps<T extends K2GateStop>(stops: T[]): K2ApprovalGaps<T> {
  const missing = stops.filter((s) => k2Evidence(s) === "missing");
  return {
    blocking: missing.filter((s) => s.status === "delivered"),
    // Unpaid stops are excluded deliberately: an undelivered, unsettled stop is
    // not on this invoice at all, so its missing document is not the admin's
    // business at the moment of approval.
    notExpected: missing.filter((s) => s.status !== "delivered" && isStopSettled(s)),
  };
}
