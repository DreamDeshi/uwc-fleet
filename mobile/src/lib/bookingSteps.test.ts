import { describe, it, expect } from "vitest";
import {
  firstBookingIssue,
  landingStep,
  stepIssue,
  STEP_WHERE,
  STEP_WHAT,
  STEP_WHEN,
  STEP_CONFIRM,
  type BookingDraft,
} from "./bookingSteps";
import { templateToForm, type BookingTemplate } from "./bookingTemplates";
import { isValidDimension, type PalletSize } from "./pallets";

const complete: BookingDraft = {
  routeTypeId: "rt1",
  stopCount: 2,
  cargoType: "pallet",
  totalPallets: 4,
  boxQty: 0,
  dimsOk: false,
};

describe("stepIssue — one step at a time", () => {
  it("Where needs a route type and at least one stop", () => {
    expect(stepIssue({ ...complete, routeTypeId: null }, STEP_WHERE)?.key).toBe("booking.selectRouteType");
    expect(stepIssue({ ...complete, stopCount: 0 }, STEP_WHERE)?.key).toBe("booking.selectConsignee");
    expect(stepIssue(complete, STEP_WHERE)).toBeNull();
  });

  it("What needs SOME cargo — nothing set anywhere is the only failure", () => {
    const empty = { ...complete, totalPallets: 0 };
    expect(stepIssue(empty, STEP_WHAT)?.key).toBe("booking.addCargo");
    expect(stepIssue({ ...empty, cargoType: "box" }, STEP_WHAT)?.key).toBe("booking.addCargo");
    for (const cargoType of ["crate", "rack", "custom"]) {
      // Nothing set anywhere, viewing a dims tab: the specific message.
      expect(stepIssue({ ...empty, cargoType, dimsOk: false }, STEP_WHAT)?.key).toBe("booking.addCargoDims");
      expect(stepIssue({ ...empty, cargoType, dimsOk: true }, STEP_WHAT)).toBeNull();
    }
  });

  /**
   * ⚠ CARGO IS A UNION, NOT AN EITHER/OR (27 Aug 2026 — the bug this pins).
   * `complete` already carries 4 pallets; each case here only changes ONE of
   * the other two cargo fields and must still see the pallets. The bug this
   * replaces: a requestor with 11 pallets entered who switched to the Box tab
   * had those pallets silently vanish, because the OLD check only looked at
   * whichever tab `cargoType` currently pointed at.
   */
  it("pallets already set is enough — an empty or incomplete OTHER tab does not block", () => {
    // Viewing Box with nothing typed in it, pallets already set: fine.
    expect(stepIssue({ ...complete, cargoType: "box", boxQty: 0 }, STEP_WHAT)).toBeNull();
    // Viewing a dims tab with incomplete dims, pallets already set: the
    // incomplete extra is just not added — it does not block the step that
    // pallets alone already satisfy.
    for (const cargoType of ["crate", "rack", "custom"]) {
      expect(stepIssue({ ...complete, cargoType, dimsOk: false }, STEP_WHAT)).toBeNull();
    }
  });

  it("box alone is enough, even with zero pallets and no dims", () => {
    expect(
      stepIssue({ ...complete, cargoType: "box", totalPallets: 0, boxQty: 3, dimsOk: false }, STEP_WHAT)
    ).toBeNull();
  });

  it("a valid dimensioned extra alone is enough, even with zero pallets and no box", () => {
    expect(
      stepIssue({ ...complete, cargoType: "rack", totalPallets: 0, boxQty: 0, dimsOk: true }, STEP_WHAT)
    ).toBeNull();
  });

  it("Confirm owns no requirement of its own", () => {
    expect(stepIssue({ routeTypeId: null, stopCount: 0, cargoType: "pallet", totalPallets: 0, boxQty: 0, dimsOk: false }, STEP_CONFIRM)).toBeNull();
  });
});

describe("firstBookingIssue — the check a jump to Confirm cannot walk around", () => {
  it("CONFIRM answers for the steps before it", () => {
    // The bug in one assertion: asking about Confirm alone (the old behaviour)
    // saw nothing wrong with a draft that has no cargo at all.
    const noCargo = { ...complete, totalPallets: 0 };
    expect(stepIssue(noCargo, STEP_CONFIRM)).toBeNull();
    expect(firstBookingIssue(noCargo, STEP_CONFIRM)).toEqual({ step: STEP_WHAT, key: "booking.addCargo" });
  });

  it("reports the EARLIEST problem, not the last", () => {
    const broken: BookingDraft = { ...complete, routeTypeId: null, totalPallets: 0 };
    expect(firstBookingIssue(broken, STEP_CONFIRM)).toEqual({ step: STEP_WHERE, key: "booking.selectRouteType" });
  });

  it("does not report a LATER step's problem while you are on an earlier one", () => {
    // Walking the wizard forward must still work: standing on Where with no
    // cargo yet is not an error, or Next could never be pressed.
    expect(firstBookingIssue({ ...complete, totalPallets: 0 }, STEP_WHERE)).toBeNull();
  });

  it("a complete draft has nothing wrong anywhere", () => {
    expect(firstBookingIssue(complete, STEP_CONFIRM)).toBeNull();
    expect(landingStep(complete)).toBe(STEP_CONFIRM);
  });

  it("the When step owns no requirement — every field on it is pre-filled", () => {
    // Deliberate, not an omission. The pickup slot defaults to the next
    // bookable one and remarks are optional, so Next must never block there.
    // If a required field is ever added to When, this is the test that has to
    // change first.
    expect(stepIssue(complete, STEP_WHEN)).toBeNull();
    expect(
      stepIssue(
        { routeTypeId: null, stopCount: 0, cargoType: "pallet", totalPallets: 0, boxQty: 0, dimsOk: false },
        STEP_WHEN
      )
    ).toBeNull();
  });

  it("still reports an EARLIER step's problem while standing on When", () => {
    // The template and rebook shortcuts can land on Confirm, which is past
    // When; walking back through it must not launder a broken draft.
    expect(firstBookingIssue({ ...complete, totalPallets: 0 }, STEP_WHEN)).toEqual({
      step: STEP_WHAT,
      key: "booking.addCargo",
    });
  });

  it("the step constants stay in wizard order", () => {
    // firstBookingIssue walks 0..upToStep, so these are indices into the
    // wizard, not labels — a reorder that broke this would silently skip a
    // step's validation.
    expect([STEP_WHERE, STEP_WHAT, STEP_WHEN, STEP_CONFIRM]).toEqual([0, 1, 2, 3]);
  });
});

/**
 * THE TWO SHAPES THIS ACTUALLY HAPPENS TO.
 *
 * Templates are device-local and never re-versioned, so a requestor's phone
 * still holds templates written against a cargo vocabulary that has since
 * changed twice. Both resolve to a draft the SERVER rejects; both used to land
 * on Confirm looking finished.
 */
describe("a legacy template that can no longer be submitted", () => {
  // The current bookable display order — 1×1 and 1×2 are deliberately absent
  // (Q1, R1 2026-07-24: those are boxes, not pallets).
  const SIZES = ["4×4", "3×4", "2×2"] as unknown as PalletSize[];

  const tpl = (over: Partial<BookingTemplate>): BookingTemplate => ({
    name: "Weekly Jabil",
    routeTypeId: "rt1",
    stops: [{ id: "c1" }, { id: "c2" }] as BookingTemplate["stops"],
    cargoType: "pallet",
    pallets: {},
    remarks: "",
    ...over,
  });

  const draftOf = (t: BookingTemplate): BookingDraft => {
    const form = templateToForm(t, SIZES);
    return {
      routeTypeId: form.routeTypeId,
      stopCount: form.stops.length,
      cargoType: form.cargoType,
      totalPallets: form.palletQtys.reduce((a, b) => a + b, 0),
      boxQty: form.boxQty,
      dimsOk:
        isValidDimension(Number(form.dimW)) &&
        isValidDimension(Number(form.dimL)) &&
        form.dimQty > 0,
    };
  };

  it('"others" becomes custom with NO dimensions — Q10 needs width × length', () => {
    const legacy = tpl({ cargoType: "others", othersText: "one big awkward crate" });
    const form = templateToForm(legacy, SIZES);
    expect(form.cargoType).toBe("custom");
    expect(form.dimW).toBe("");
    expect(form.dimL).toBe("");
    // The server rejects width_ft: 0 (`.positive()`), so this must never reach
    // Submit — it lands on What with the app's own message instead.
    expect(landingStep(draftOf(legacy))).toBe(STEP_WHAT);
    expect(firstBookingIssue(draftOf(legacy), STEP_CONFIRM)?.key).toBe("booking.addCargoDims");
  });

  it("a 1×1/1×2-only pallet template resolves to zero cargo", () => {
    const legacy = tpl({ pallets: { "1×1": 5, "1×2": 3 } as BookingTemplate["pallets"] });
    expect(templateToForm(legacy, SIZES).palletQtys).toEqual([0, 0, 0]);
    // cargo_details would be [] — the server needs at least one line.
    expect(landingStep(draftOf(legacy))).toBe(STEP_WHAT);
    expect(firstBookingIssue(draftOf(legacy), STEP_CONFIRM)?.key).toBe("booking.addCargo");
  });

  it('"carton" survives intact — its count maps straight onto box', () => {
    // Not every legacy shape is broken, and the fix must not send a working
    // template to a step that needs nothing.
    const legacy = tpl({ cargoType: "carton", cartonQty: 12 });
    const form = templateToForm(legacy, SIZES);
    expect(form.cargoType).toBe("box");
    expect(form.boxQty).toBe(12);
    expect(landingStep(draftOf(legacy))).toBe(STEP_CONFIRM);
  });

  it("a current template still takes the shortcut it was built for", () => {
    const current = tpl({ pallets: { "4×4": 2 } as BookingTemplate["pallets"] });
    expect(landingStep(draftOf(current))).toBe(STEP_CONFIRM);
    expect(firstBookingIssue(draftOf(current), STEP_CONFIRM)).toBeNull();
  });

  it("boxQty prefers the NEW field over the legacy one", () => {
    const both = tpl({ cargoType: "box", boxQty: 4, cartonQty: 99 });
    expect(templateToForm(both, SIZES).boxQty).toBe(4);
  });
});

/**
 * ⚠ CARGO IS A UNION, NOT AN EITHER/OR (27 Aug 2026). A saved template can
 * now carry pallets AND a box AND a dimensioned extra together — the exact
 * combination ("11 pallet + 1 box") that Mr. Teh's own bug report used.
 */
describe("templateToForm — a template can carry pallets + box + a dimensioned extra together", () => {
  const SIZES = ["4×4", "3×4", "2×2"] as unknown as PalletSize[];
  const tpl = (over: Partial<BookingTemplate>): BookingTemplate => ({
    name: "Mixed load",
    routeTypeId: "rt1",
    stops: [],
    cargoType: "pallet",
    pallets: {},
    remarks: "",
    ...over,
  });

  it("restores pallets and box together, regardless of which tab cargoType lands on", () => {
    const saved = tpl({
      cargoType: "box", // whichever tab was active when saved
      pallets: { "4×4": 11 } as BookingTemplate["pallets"],
      boxQty: 1,
    });
    const form = templateToForm(saved, SIZES);
    expect(form.palletQtys).toEqual([11, 0, 0]);
    expect(form.boxQty).toBe(1);
    const draft: BookingDraft = {
      routeTypeId: form.routeTypeId,
      stopCount: 0,
      cargoType: form.cargoType,
      totalPallets: form.palletQtys.reduce((a, b) => a + b, 0),
      boxQty: form.boxQty,
      dimsOk: false,
    };
    expect(stepIssue(draft, STEP_WHAT)).toBeNull(); // both present, nothing missing
  });

  it("dimType is preserved independently of cargoType, so a Rack extra survives landing on Pallet", () => {
    const saved = tpl({
      cargoType: "pallet", // the tab it was left on
      pallets: { "4×4": 2 } as BookingTemplate["pallets"],
      dimType: "rack",
      dimW: "4",
      dimL: "4",
      dimQty: 1,
    });
    expect(templateToForm(saved, SIZES).dimType).toBe("rack");
  });

  it("a template saved before dimType existed falls back to cargoType when it IS a dimensioned type", () => {
    const legacy = tpl({ cargoType: "crate", dimW: "3", dimL: "3", dimQty: 1 });
    expect(templateToForm(legacy, SIZES).dimType).toBe("crate");
  });

  it("a template with no dimensioned extra at all defaults dimType to crate (harmless — dimsOk stays false)", () => {
    const plain = tpl({ pallets: { "4×4": 1 } as BookingTemplate["pallets"] });
    expect(templateToForm(plain, SIZES).dimType).toBe("crate");
  });
});
