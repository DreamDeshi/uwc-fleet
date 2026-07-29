import { describe, it, expect } from "vitest";
import {
  CUSTOMS_DOC_ZONE,
  requiresCustomsDoc,
  isDocumentationComplete,
} from "../src/services/incentiveEngine";

// The customs-document gate blocks Delivered, and Delivered is what moves pay.
// It shipped keyed on zone code "K2" — which is Sungai Petani + Kuala Ketil, NOT
// the Penang Island area that actually needs the form. Mr. Teh, R3 2026-07-29:
// "Only Penang bayan Lepas area require K2." Bayan Lepas is zone P1.
//
// These tests exist so the zone can never drift back by someone pattern-matching
// the feature's name against the zone's name.

const complete = { do_uploaded: true, pod_photo: "pod.jpg", k2_photo: null as string | null };

describe("which zone needs a customs document", () => {
  it("is P1 (Penang Island / Bayan Lepas)", () => {
    expect(CUSTOMS_DOC_ZONE).toBe("P1");
    expect(requiresCustomsDoc("P1")).toBe(true);
  });

  it("is NOT the zone that happens to be CALLED K2", () => {
    // Sungai Petani + Kuala Ketil. The old gate fired here and blocked pay.
    expect(requiresCustomsDoc("K2")).toBe(false);
  });

  it("no other zone needs one", () => {
    for (const z of ["P2", "P3", "K1", "A1", "A2"]) {
      expect(requiresCustomsDoc(z)).toBe(false);
    }
  });
});

describe("isDocumentationComplete — the gate itself", () => {
  it("P1 stop WITHOUT a customs document is not deliverable", () => {
    expect(isDocumentationComplete({ ...complete, k2_photo: null }, "P1")).toBe(false);
  });

  it("P1 stop WITH one is deliverable", () => {
    expect(isDocumentationComplete({ ...complete, k2_photo: "doc.jpg" }, "P1")).toBe(true);
  });

  it("REGRESSION: a Sungai Petani (K2) stop no longer needs one", () => {
    // This is the bug being fixed — it used to return false and strand the
    // driver at a stop he could not mark delivered.
    expect(isDocumentationComplete({ ...complete, k2_photo: null }, "K2")).toBe(true);
  });

  it("the POD photo is still required everywhere, customs zone or not", () => {
    expect(isDocumentationComplete({ do_uploaded: true, pod_photo: null, k2_photo: "d.jpg" }, "P1")).toBe(false);
    expect(isDocumentationComplete({ do_uploaded: true, pod_photo: null, k2_photo: null }, "P2")).toBe(false);
  });

  it("do_uploaded is still required everywhere", () => {
    expect(isDocumentationComplete({ do_uploaded: false, pod_photo: "p.jpg", k2_photo: "d.jpg" }, "P1")).toBe(false);
  });

  it("WHAT the document is, is never inspected — any upload satisfies it", () => {
    // R3: "you just let them upload any document will do." The server has never
    // looked inside the file and must not start; the admin reviewing it at
    // approval is the check.
    expect(isDocumentationComplete({ ...complete, k2_photo: "a-random-photo.jpg" }, "P1")).toBe(true);
  });
});
