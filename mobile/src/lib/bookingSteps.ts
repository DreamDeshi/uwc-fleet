// What makes a booking draft SUBMITTABLE, and which wizard step owns each
// requirement. Pure (no React, no state) so every branch is unit-tested.
//
// ── WHY THIS IS A LIB AND NOT AN `if` IN THE SCREEN ────────────────────────
//
// It was an `if` in the screen, and it only ever validated the step the
// requestor was LOOKING AT:
//
//     if (step === 0) { ...route type, stops... }
//     if (step === 1) { ...cargo... }
//     return null;                      // ← step 2 (Confirm) checks NOTHING
//
// Which is correct while you walk the wizard, and useless the moment something
// jumps you past a step — and TWO things do. "Load saved template" and "Rebook
// last trip" both end with `setStep(STEPS.length - 1)`, landing straight on
// Confirm. From there Submit ran with steps 0 and 1 never validated.
//
// That is not theoretical for templates, because templates are DEVICE-LOCAL and
// long-lived (AsyncStorage, key `requestor.bookingTemplates.v1`, never
// re-versioned) while the cargo vocabulary has moved under them twice:
//
//   1. A template saved as cargoType "others" — a free-text size — maps onto
//      Q10's "custom", which requires structured width × length in feet. The
//      old template has no dimensions to give, so the form loads 0 × 0.
//   2. A template whose pallets are only 1×1 or 1×2 — deprecated as bookable
//      footprints on 24 Jul 2026 ("those are boxes, not pallets") — resolves to
//      every quantity zero, because the form's PALLET_SIZES no longer lists
//      them.
//
// Both land on Confirm looking finished, and both are rejected by the SERVER on
// submit (`width_ft` must be positive; `cargo_details` needs at least one
// line). The requestor gets a validation error from the API on a screen whose
// entire job was to have already caught it — and the app has the right message
// for both cases, sitting behind a check that was skipped.
//
// So the rule is: validate every step UP TO AND INCLUDING the one you are on,
// and let the caller ask about the last step to mean "everything".

export const STEP_WHERE = 0;
export const STEP_WHAT = 1;
export const STEP_CONFIRM = 2;

/** The parts of the booking form that decide submittability. */
export interface BookingDraft {
  routeTypeId: string | null | undefined;
  stopCount: number;
  /** After the legacy mapping — "carton"/"others" must already be resolved. */
  cargoType: string;
  /** Pallet quantities summed, INCLUDING preserved legacy lines. */
  totalPallets: number;
  boxQty: number;
  /** Width, length and quantity all present and positive. */
  dimsOk: boolean;
}

export interface BookingIssue {
  /** The step that owns this requirement — where to send the requestor. */
  step: number;
  /** i18n key; the caller translates. */
  key: string;
}

const DIMENSIONED = ["crate", "rack", "custom"];

/** Everything wrong with THIS step, or null. */
export function stepIssue(draft: BookingDraft, step: number): BookingIssue | null {
  if (step === STEP_WHERE) {
    if (!draft.routeTypeId) return { step, key: "booking.selectRouteType" };
    if (draft.stopCount === 0) return { step, key: "booking.selectConsignee" };
  }
  if (step === STEP_WHAT) {
    if (draft.cargoType === "pallet" && draft.totalPallets === 0) {
      return { step, key: "booking.addCargo" };
    }
    if (draft.cargoType === "box" && draft.boxQty === 0) {
      return { step, key: "booking.addCargo" };
    }
    if (DIMENSIONED.includes(draft.cargoType) && !draft.dimsOk) {
      return { step, key: "booking.addCargoDims" };
    }
  }
  return null;
}

/**
 * The FIRST problem at or before `upToStep`, so a jump to Confirm still answers
 * for the steps it skipped. Pass STEP_CONFIRM to mean "is this submittable".
 *
 * Returns the earliest issue, not any issue: the requestor should be sent to
 * the first thing that needs them, not the last.
 */
export function firstBookingIssue(draft: BookingDraft, upToStep: number): BookingIssue | null {
  for (let s = 0; s <= upToStep; s++) {
    const issue = stepIssue(draft, s);
    if (issue) return issue;
  }
  return null;
}

/**
 * Where a fast path (load-template / rebook) should LAND. Confirm when the
 * draft is complete — the whole point of the shortcut — otherwise the step that
 * needs attention, rather than a Confirm screen that cannot be confirmed.
 */
export function landingStep(draft: BookingDraft): number {
  return firstBookingIssue(draft, STEP_CONFIRM)?.step ?? STEP_CONFIRM;
}
