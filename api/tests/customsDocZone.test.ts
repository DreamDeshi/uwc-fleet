import { describe, it, expect } from "vitest";
import {
  CUSTOMS_DOC_ZONE,
  CUSTOMS_DOC_AREA,
  requiresCustomsDoc,
  isDocumentationComplete,
  k2BlockingStops,
  type K2GateStop,
} from "../src/services/incentiveEngine";

// The customs-document gate blocks Delivered, and Delivered is what moves pay.
//
// It shipped keyed on zone code "K2" — Sungai Petani + Kuala Ketil — because
// the FEATURE is named after Borang K2 and the zone code "K2" is an unrelated
// coincidence. Mr. Teh, R3 2026-07-29: "Only Penang bayan Lepas area require
// K2." Bayan Lepas is an AREA inside zone P1 (Penang Island), not a zone: on
// prod, P1 holds 412 consignees of which 192 are Bayan Lepas. Gating the zone
// would strand the other 220.

const complete = { do_uploaded: true, pod_photo: "pod.jpg", k2_photo: null as string | null };
const BL = "BAYAN LEPAS";

describe("what needs a customs document", () => {
  it("is the Bayan Lepas AREA inside zone P1", () => {
    expect(CUSTOMS_DOC_ZONE).toBe("P1");
    expect(CUSTOMS_DOC_AREA).toBe("BAYAN LEPAS");
    expect(requiresCustomsDoc("P1", BL)).toBe(true);
  });

  it("is NOT the zone that happens to be CALLED K2", () => {
    expect(requiresCustomsDoc("K2", BL)).toBe(false);
    expect(requiresCustomsDoc("K2", null)).toBe(false);
  });

  it("is NOT the rest of Penang Island", () => {
    // The 220 consignees Mr. Teh never named.
    for (const area of ["GEORGE TOWN", "BATU MAUNG", "JELUTONG", "GELUGOR", "AYER ITAM"]) {
      expect(requiresCustomsDoc("P1", area)).toBe(false);
    }
  });

  it("is not any other zone, whatever the area says", () => {
    for (const z of ["P2", "P3", "K1", "A1", "A2"]) {
      expect(requiresCustomsDoc(z, BL)).toBe(false);
    }
  });
});

describe("area is FREE TEXT — matching has to survive what requestors type", () => {
  it("ignores case", () => {
    expect(requiresCustomsDoc("P1", "bayan lepas")).toBe(true);
    expect(requiresCustomsDoc("P1", "Bayan Lepas")).toBe(true);
    expect(requiresCustomsDoc("P1", "BaYaN lEpAs")).toBe(true);
  });

  it("ignores leading, trailing and doubled whitespace", () => {
    expect(requiresCustomsDoc("P1", "  bayan lepas  ")).toBe(true);
    expect(requiresCustomsDoc("P1", "BAYAN  LEPAS")).toBe(true);
    expect(requiresCustomsDoc("P1", "\tBAYAN\nLEPAS ")).toBe(true);
  });

  it("matches when the name sits INSIDE a longer area string", () => {
    // These read like real rows, not like a tidy enum.
    expect(requiresCustomsDoc("P1", "KAWASAN PERINDUSTRIAN BAYAN LEPAS")).toBe(true);
    expect(requiresCustomsDoc("P1", "Bayan Lepas FIZ Phase 4")).toBe(true);
  });
});

describe("FAILS OPEN — a stranded driver is worse than a missing document", () => {
  // Owner ruling 29 Jul: "a missing document is recoverable at POD approval;
  // a stranded driver isn't."
  it("a blank area does not gate", () => {
    expect(requiresCustomsDoc("P1", "")).toBe(false);
    expect(requiresCustomsDoc("P1", "   ")).toBe(false);
  });

  it("a missing area does not gate", () => {
    expect(requiresCustomsDoc("P1", null)).toBe(false);
    expect(requiresCustomsDoc("P1", undefined)).toBe(false);
    expect(requiresCustomsDoc("P1")).toBe(false);
  });

  it("an unrecognised area does not gate", () => {
    expect(requiresCustomsDoc("P1", "somewhere new the requestor typed")).toBe(false);
  });
});

describe("isDocumentationComplete — the gate itself", () => {
  it("a Bayan Lepas stop WITHOUT a customs document is not deliverable", () => {
    expect(isDocumentationComplete({ ...complete, k2_photo: null }, "P1", BL)).toBe(false);
  });

  it("a Bayan Lepas stop WITH one is deliverable", () => {
    expect(isDocumentationComplete({ ...complete, k2_photo: "doc.jpg" }, "P1", BL)).toBe(true);
  });

  it("REGRESSION: a Sungai Petani (K2) stop no longer needs one", () => {
    // The original bug — it used to return false and strand the driver.
    expect(isDocumentationComplete({ ...complete, k2_photo: null }, "K2", "SUNGAI PETANI")).toBe(true);
  });

  it("REGRESSION: the rest of Penang Island does not need one", () => {
    // The bug the zone-wide fix would have introduced.
    expect(isDocumentationComplete({ ...complete, k2_photo: null }, "P1", "GEORGE TOWN")).toBe(true);
  });

  it("the POD photo is still required everywhere", () => {
    expect(isDocumentationComplete({ do_uploaded: true, pod_photo: null, k2_photo: "d.jpg" }, "P1", BL)).toBe(false);
    expect(isDocumentationComplete({ do_uploaded: true, pod_photo: null, k2_photo: null }, "P2", null)).toBe(false);
  });

  it("do_uploaded is still required everywhere", () => {
    expect(isDocumentationComplete({ do_uploaded: false, pod_photo: "p.jpg", k2_photo: "d.jpg" }, "P1", BL)).toBe(false);
  });

  it("WHAT the document is, is never inspected — any upload satisfies it", () => {
    // R3: "you just let them upload any document will do."
    expect(isDocumentationComplete({ ...complete, k2_photo: "a-random-photo.jpg" }, "P1", BL)).toBe(true);
  });
});

describe("k2BlockingStops — the server-side approval gate's input", () => {
  const bl = (over: Partial<K2GateStop> = {}): K2GateStop => ({
    sequence: 1,
    status: "delivered",
    k2_photo: null,
    consignee: { zone_code: "P1", area: BL },
    ...over,
  });

  it("flags a delivered Bayan Lepas stop with no k2_photo", () => {
    expect(k2BlockingStops([bl()])).toEqual([bl()]);
  });

  it("does not flag one that has a k2_photo", () => {
    expect(k2BlockingStops([bl({ k2_photo: "doc.jpg" })])).toEqual([]);
  });

  it("does not flag an undelivered stop, even with no k2_photo", () => {
    // Not on the approval invoice at all yet — see k2ApprovalGaps' "notExpected".
    expect(k2BlockingStops([bl({ status: "pending" })])).toEqual([]);
  });

  it("does not flag a delivered stop outside the customs-document area", () => {
    expect(k2BlockingStops([bl({ consignee: { zone_code: "P1", area: "GEORGE TOWN" } })])).toEqual([]);
  });

  it("does not flag a stop with no consignee joined", () => {
    expect(k2BlockingStops([bl({ consignee: null })])).toEqual([]);
  });

  it("names every blocking stop, not just the first", () => {
    const stops = [bl({ sequence: 1 }), bl({ sequence: 2, k2_photo: "doc.jpg" }), bl({ sequence: 3 })];
    expect(k2BlockingStops(stops).map((s) => s.sequence)).toEqual([1, 3]);
  });
});
