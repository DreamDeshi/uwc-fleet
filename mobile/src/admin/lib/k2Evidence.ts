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
  consignee?: { zone_code?: string | null; area?: string | null };
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
  // Optional-chained deliberately even though the admin payload always joins a
  // consignee: this runs inside the render of every card in the approval queue,
  // so a throw here blanks the whole queue rather than one row. Matches the
  // convention in TripStopLadder/ActiveTripScreen, where the driver-side
  // TripStop.consignee genuinely is optional.
  if (requiresCustomsDoc(stop.consignee?.zone_code, stop.consignee?.area)) return "missing";
  return "not_required";
}

export interface K2GateStop extends K2StopLike, SettleableStop {}

export interface K2ApprovalGaps<T> {
  /**
   * DELIVERED with the required document absent. Marking a stop delivered is
   * exactly what the upload gate stands in front of, so on current rules this
   * combination is unreachable — the only writer of `status: "delivered"`
   * (api/src/routes/trips.ts) sits immediately behind isDocumentationComplete.
   * Blocks Approve behind a confirm.
   *
   * ⚠ THE LEGACY WINDOW IS PRE-**29** JUL, NOT PRE-25 JUL, and getting that
   * wrong understates it by the entire zone retarget. `k2_photo` arrived on
   * 25 Jul (20260725150000_k2_document_upload) — but until aee7a28 on 29 Jul
   * the gate was on the WRONG ZONE: it fired for zone code "K2" (Sungai
   * Petani) and NOT for P1/Bayan Lepas. So every P1 + Bayan Lepas stop
   * delivered before 29 Jul has no k2_photo BY CONSTRUCTION and was delivered
   * entirely correctly under the rule then in force.
   *
   * Such a row lands here and cannot be remediated: the K2 upload route
   * finalize-locks at `pending_approval` (409 POD_LOCKED), so the document
   * cannot be supplied after the fact. Whether those rows should be exempt is
   * an OWNER decision — do not invent a delivered_at cutoff here.
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

export type ApprovalStep<V> = { kind: "approve" | "confirm"; vars: V };

/**
 * Does this approval go straight through, or via the K2 confirm — and with
 * exactly what payload?
 *
 * ⚠ EXTRACTED SO THE HAND-OFF IS PINNED BY A TEST RATHER THAN BY READING. The
 * screen has TWO entry points that release pay (the Approve button and the
 * Edit-rate submit), and the edited one carries a `final_amount` plus the
 * reason the server makes mandatory for a changed amount. Those have to survive
 * a round trip through React state while a modal closes and another opens. A
 * silent drop there would approve an EDITED trip at the PROPOSED amount — a
 * wrong payment with an audit trail that says the admin chose it.
 *
 * `vars` is returned by reference, never rebuilt, so the test can assert
 * identity rather than deep equality and catch a reconstruction too.
 */
export function approvalStep<V>(vars: V, gaps: Pick<K2ApprovalGaps<unknown>, "blocking">): ApprovalStep<V> {
  return { kind: gaps.blocking.length > 0 ? "confirm" : "approve", vars };
}
