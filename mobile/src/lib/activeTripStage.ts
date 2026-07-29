// The active-trip pinned footer's single primary action for the CURRENT
// target stop (29 Jul redesign: one primary at a time — "Delivered alone in
// the pinned footer"). Pure so the K2→Delivered gate ordering is
// unit-testable: the ladder must never offer Delivered while the server-side
// documentation gate (isDocumentationComplete: POD photo + K2 upload for K2
// zones) would refuse it, and must never skip the K2 step on a K2 stop.
//
// Mirrors the server gate's SHAPE only — the server remains the authority;
// this decides which button to show, never whether pay moves.

/**
 * The ONE zone whose deliveries need a customs document before Delivered.
 *
 * ⚠ THIS IS "P1" (Penang Island), NOT the zone literally CALLED "K2".
 *
 * Mr. Teh, R3 2026-07-29: "Only Penang bayan Lepas area require K2." Bayan
 * Lepas is on Penang Island = zone P1. The gate had been keyed on zone code
 * "K2" (Sungai Petani + Kuala Ketil) because the FEATURE is named after Borang
 * K2 and the zone code "K2" is an unrelated coincidence — so it fired on the
 * wrong towns from the day it shipped, blocking Delivered (and pay) in Sungai
 * Petani while letting Bayan Lepas through.
 *
 * MUST mirror CUSTOMS_DOC_ZONE in api/src/services/incentiveEngine.ts. If these
 * two disagree, the driver's app and the server disagree about whether a stop
 * can be delivered at all.
 */
export const CUSTOMS_DOC_ZONE = "P1";

/**
 * …and the AREA inside it. Zone P1 is the whole of Penang Island — only about
 * half its consignees are in Bayan Lepas — so gating the zone would demand a
 * document from George Town, Jelutong, Gelugor and the rest, blocking
 * Delivered (and pay) at each. Owner decision 29 Jul: gate the AREA.
 */
export const CUSTOMS_DOC_AREA = "BAYAN LEPAS";

/** `area` is free text typed by requestors — normalise before comparing. */
function normaliseArea(area: string | null | undefined): string {
  return (area ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * True when this delivery must carry a customs document.
 *
 * FAILS OPEN: a blank or unrecognised area does NOT gate — "a missing document
 * is recoverable at POD approval; a stranded driver isn't" (owner, 29 Jul).
 * Matching is `includes` because real rows read "KAWASAN PERINDUSTRIAN BAYAN
 * LEPAS" as often as the bare name.
 *
 * MUST mirror requiresCustomsDoc in api/src/services/incentiveEngine.ts.
 */
export function requiresCustomsDoc(
  zoneCode: string | null | undefined,
  area?: string | null
): boolean {
  if (zoneCode !== CUSTOMS_DOC_ZONE) return false;
  return normaliseArea(area).includes(CUSTOMS_DOC_AREA);
}

export type FooterStage =
  | "arrived" // stop still pending → Arrived is the primary
  | "pod" // arrived, no POD yet → capture (opens the review step first)
  | "k2" // POD done, K2 zone missing its uploaded form → Upload Borang K2
  | "delivered" // gates satisfied → Delivered (accent), alone
  | null; // nothing to do here (delivered already / delivery queued offline)

export interface StageStop {
  status: string; // "pending" | "arrived" | "delivered"
  pod_photo?: string | null;
  do_uploaded?: boolean;
  k2_photo?: string | null;
}

export interface StageFlags {
  /** Stop needs a customs document → that upload gates Delivered.
   *  Derive it with `requiresCustomsDoc(zone_code)`, never a bare comparison. */
  isK2: boolean;
  /** Arrived saved on-phone (offline outbox) — unlocks the POD step locally. */
  arrivedQueued?: boolean;
  /** POD photo captured + queued offline (counts as done for the ladder). */
  podQueued?: boolean;
  /** Delivered intent already queued offline — nothing left to press. */
  deliveryQueued?: boolean;
}

export function footerStage(stop: StageStop, flags: StageFlags): FooterStage {
  if (stop.status === "delivered" || flags.deliveryQueued) return null;
  const arrived = stop.status === "arrived" || (stop.status === "pending" && !!flags.arrivedQueued);
  if (!arrived) return "arrived";
  const podDone = !!stop.pod_photo || !!flags.podQueued || !!stop.do_uploaded;
  if (!podDone) return "pod";
  // K2 gate: the ACTUAL uploaded document only — the legacy ack tick never
  // satisfies it (Q6 rule, same as the server's isDocumentationComplete).
  if (flags.isK2 && !stop.k2_photo) return "k2";
  return "delivered";
}

/**
 * Q1 ruling (29 Jul): re-pointing to another stop is ALLOWED while a stop has
 * an uploaded POD but no Delivered — but that stop must wear a persistent
 * "waiting for Delivered" banner until the tap happens (an uploaded POD with
 * no Delivered is one tap away from finalized pay; forgetting it is the
 * failure mode). True for stops that are NOT the current target.
 */
export function waitingForDelivered(stop: StageStop, flags: StageFlags): boolean {
  return footerStage(stop, flags) === "delivered" || footerStage(stop, flags) === "k2";
}
