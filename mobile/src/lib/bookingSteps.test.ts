import { describe, it, expect } from "vitest";
import {
  firstBookingIssue,
  landingStep,
  stepIssue,
  STEP_WHERE,
  STEP_WHAT,
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

  it("What needs cargo, per type", () => {
    expect(stepIssue({ ...complete, totalPallets: 0 }, STEP_WHAT)?.key).toBe("booking.addCargo");
    expect(stepIssue({ ...complete, cargoType: "box", boxQty: 0 }, STEP_WHAT)?.key).toBe("booking.addCargo");
    for (const cargoType of ["crate", "rack", "custom"]) {
      expect(stepIssue({ ...complete, cargoType, dimsOk: false }, STEP_WHAT)?.key).toBe("booking.addCargoDims");
      expect(stepIssue({ ...complete, cargoType, dimsOk: true }, STEP_WHAT)).toBeNull();
    }
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
