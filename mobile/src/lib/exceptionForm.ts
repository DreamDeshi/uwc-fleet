import type { PickedPhoto } from "./photo";

// PURE exception helpers — validation, category vocabulary, state display, and
// the requestor redaction projection. No React / RN imports, so this is
// unit-tested in plain node (same discipline as the outbox core).

// The FIVE confirmed categories (Mr. Teh's Q2 A–E). `i18nKey` resolves the label.
export const EXCEPTION_CATEGORIES = [
  { key: "customer_site", i18nKey: "exception.category.customer_site" },
  { key: "truck", i18nKey: "exception.category.truck" },
  { key: "cargo", i18nKey: "exception.category.cargo" },
  { key: "external", i18nKey: "exception.category.external" },
  { key: "documentation", i18nKey: "exception.category.documentation" },
] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number]["key"];
const CATEGORY_KEYS = EXCEPTION_CATEGORIES.map((c) => c.key) as readonly string[];

// The four canned phrases (design frame 19). They cover what a driver actually
// reports from a kerbside, one tap instead of typing at a locked gate. They
// APPEND to the note rather than replacing it, so "Gate locked" plus his own
// words both survive — the reason field stays free text and the server is
// unchanged.
export const CANNED_REASONS = [
  { key: "gate_locked", i18nKey: "exception.canned.gateLocked" },
  { key: "nobody_at_site", i18nKey: "exception.canned.nobodyAtSite" },
  { key: "site_closed", i18nKey: "exception.canned.siteClosed" },
  { key: "wrong_address", i18nKey: "exception.canned.wrongAddress" },
] as const;

export type ExceptionState = "reported" | "more_evidence" | "verified" | "rejected" | "resolved";

const OPEN_STATES: ReadonlySet<ExceptionState> = new Set(["reported", "more_evidence", "verified"]);
export function isOpenState(state: string): boolean {
  return OPEN_STATES.has(state as ExceptionState);
}

/** i18n key for a state label (driver/admin full view). */
export function exceptionStateLabelKey(state: string): string {
  return `exception.state.${state}`;
}

/**
 * C9 — WHAT THE REQUESTOR IS SHOWN ON A FAILED DELIVERY.
 *
 * Mr. Teh, 11 Aug 2026: "OPTION B" — the REASON (his example: nobody at site to
 * receive), never the pay decision.
 *
 * The requestor's redacted payload carries the CATEGORY, coarse status and
 * timestamps, and nothing else — the driver's `reason` is free text (≤2000
 * chars, his own words at a kerbside) and is deliberately not in that contract.
 * So the category is the only reason-bearing field a requestor may see, and it
 * was being rendered through `exception.category.*` — the DRIVER'S PICKER
 * labels, which are a taxonomy ("Customer / Site", "Truck") and read as
 * filing, not as an explanation.
 *
 * These labels restate the same five categories as a reason, in Mr. Teh's own
 * words from the workflow he specified (R1 Q2, 24 Jul 2026): "A. Customer /
 * Site Problem · B. Truck Problem · C. Cargo Problem · D. External Problem
 * (flood, bad weather, security issue) · E. Documentation Problem". The word
 * his categories all carried — PROBLEM — is what the picker labels dropped.
 *
 * ⚠ NOT the finer grain. His C9 example, "nobody at site to receive", is a
 * CANNED_REASON, and those are appended to free text rather than stored as a
 * code — there is no structured field to redact and translate. Surfacing that
 * exact line needs a column on TripException, which is frozen. Logged as an
 * open item; this ships the honest granularity the data already supports.
 *
 * Returns null for a category outside the five, so an unknown value renders
 * NOTHING rather than a raw i18n key on a customer's screen.
 */
export function requestorReasonLabelKey(category: string): string | null {
  return CATEGORY_KEYS.includes(category) ? `exception.requestorReason.${category}` : null;
}

// ── Driver report form validation (pure) ─────────────────────────────────────
export interface ExceptionFormValues {
  category: string | null;
  reason: string;
  photo: PickedPhoto | null;
}
/** Returns an i18n error key for the FIRST problem, or null when valid. Mirrors
 *  the server gates (valid category, non-empty reason ≤2000, photo present). */
export function validateExceptionForm(v: ExceptionFormValues): string | null {
  if (!v.category || !CATEGORY_KEYS.includes(v.category)) return "exception.validation.categoryRequired";
  if (!v.reason || v.reason.trim().length === 0) return "exception.validation.reasonRequired";
  if (v.reason.trim().length > 2000) return "exception.validation.reasonTooLong";
  if (!v.photo) return "exception.validation.photoRequired";
  return null;
}

/** The driver may add MORE evidence only when the admin asked for it. */
/**
 * THE OFFICE'S LAST WORDS TO THE DRIVER.
 *
 * Every admin action on an exception can carry a `note`, it is stored on the
 * append-only action log, and the DRIVER is served the full view — notes
 * included. Until 17 Aug 2026 nothing rendered it: a dispatcher typing
 * "customer says try the side gate" had it delivered to the driver's device
 * and thrown away, and he phoned the office to ask what he had already been
 * told.
 *
 * Latest wins. The log is append-only and an admin can act more than once
 * (request evidence, then verify, then resolve); the newest note is the
 * standing instruction, and older ones are history he does not need at a
 * locked gate.
 *
 * ⚠ ADMIN NOTES ONLY. A driver's own evidence note must never come back to him
 * as if the office had said it.
 */
export interface OfficeNote {
  note: string;
  at: string;
  /** Which action carried it — drives the label ("asked for", "decided"). */
  type: string;
}

export function latestOfficeNote(
  actions: ReadonlyArray<{ actor_role?: string | null; note?: string | null; type?: string | null; created_at?: string | null }> | null | undefined
): OfficeNote | null {
  if (!actions || actions.length === 0) return null;
  let best: OfficeNote | null = null;
  let bestAt = -Infinity;
  for (const a of actions) {
    if (a.actor_role !== "admin") continue;
    const note = (a.note ?? "").trim();
    if (!note) continue;
    // A missing/unparseable timestamp must not win by accident — treat it as
    // the oldest, so a real dated note always beats it.
    const at = a.created_at ? Date.parse(a.created_at) : NaN;
    const rank = Number.isNaN(at) ? -Infinity : at;
    if (rank >= bestAt) {
      bestAt = rank;
      best = { note, at: a.created_at ?? "", type: a.type ?? "" };
    }
  }
  return best;
}

/**
 * Is this exception CLOSED with an outcome the driver has to be told?
 *
 * `rejected` and `resolved` are terminal. The card used to render nothing at
 * all for them, so a rejection — which is final, has no undo path, and means
 * the stop does not pay — reached the driver as a component quietly
 * disappearing. The first he knew of it was his pay.
 */
export function isClosedOutcome(state: string): boolean {
  return state === "rejected" || state === "resolved";
}

export function canDriverAddEvidence(state: string): boolean {
  return state === "more_evidence";
}

// ── Requestor redaction projection (pure, defense-in-depth) ───────────────────
// The server already returns a redacted payload to a requestor, but the client
// NEVER trusts a payload to be safe: this projection re-derives ONLY the
// permitted fields, so even if a full payload reached a requestor screen no
// GPS / evidence / notes / actor ids / raw operational detail is ever rendered.
export interface RequestorExceptionView {
  category: string;
  status: "open" | "resolved";
  reportedAt: string | null;
  resolvedAt: string | null;
  stopSequence: number | null;
}
export function toRequestorView(exc: Record<string, unknown> | null | undefined): RequestorExceptionView | null {
  if (!exc || typeof exc !== "object") return null;
  const category = typeof exc.category === "string" ? exc.category : "";
  // Accept the server's coarse `status`; if a full payload leaked, derive it
  // from closed_at and expose nothing else.
  const status: "open" | "resolved" =
    exc.status === "resolved" || exc.status === "open"
      ? (exc.status as "open" | "resolved")
      : exc.closed_at
        ? "resolved"
        : "open";
  const reportedAt = typeof exc.reported_at === "string" ? exc.reported_at : null;
  const resolvedAt = typeof exc.resolved_at === "string" ? exc.resolved_at : null;
  const stopSequence =
    exc.stop_sequence != null && Number.isFinite(Number(exc.stop_sequence)) ? Number(exc.stop_sequence) : null;
  return { category, status, reportedAt, resolvedAt, stopSequence };
}
