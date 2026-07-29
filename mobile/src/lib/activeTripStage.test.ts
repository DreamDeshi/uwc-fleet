import { describe, it, expect } from "vitest";
import {
  footerStage,
  waitingForDelivered,
  requiresCustomsDoc,
  CUSTOMS_DOC_ZONE,
} from "./activeTripStage";

// The client's copy of the zone MUST match the server's (CUSTOMS_DOC_ZONE in
// api/src/services/incentiveEngine.ts). If they disagree, the app offers
// Delivered on a stop the server will refuse — or hides it on one it would
// accept. Mr. Teh, R3 2026-07-29: "Only Penang bayan Lepas area require K2" —
// Bayan Lepas is Penang Island = zone P1, NOT the zone called "K2".
describe("which zone needs a customs document (client mirror)", () => {
  it("is P1, matching the server constant", () => {
    expect(CUSTOMS_DOC_ZONE).toBe("P1");
    expect(requiresCustomsDoc("P1")).toBe(true);
  });

  it("is NOT the zone that happens to be CALLED K2", () => {
    expect(requiresCustomsDoc("K2")).toBe(false);
  });

  it("tolerates a stop with no zone at all", () => {
    expect(requiresCustomsDoc(null)).toBe(false);
    expect(requiresCustomsDoc(undefined)).toBe(false);
  });
});

const stop = (over: Partial<Parameters<typeof footerStage>[0]> = {}) => ({
  status: "arrived",
  pod_photo: null,
  do_uploaded: false,
  k2_photo: null,
  ...over,
});

describe("footerStage — the one-primary-at-a-time ladder", () => {
  it("pending stop → Arrived", () => {
    expect(footerStage(stop({ status: "pending" }), { isK2: false })).toBe("arrived");
  });

  it("arrived without a POD → capture (the review step's entry)", () => {
    expect(footerStage(stop(), { isK2: false })).toBe("pod");
  });

  it("POD done on a non-K2 stop → Delivered, alone", () => {
    expect(footerStage(stop({ pod_photo: "x" }), { isK2: false })).toBe("delivered");
  });

  it("K2 GATE ORDER: POD done but no K2 upload on a K2 stop → the K2 step, NEVER Delivered", () => {
    expect(footerStage(stop({ pod_photo: "x" }), { isK2: true })).toBe("k2");
  });

  it("K2 stop with BOTH uploads → Delivered", () => {
    expect(footerStage(stop({ pod_photo: "x", k2_photo: "y" }), { isK2: true })).toBe("delivered");
  });

  it("the legacy k2 ACK never unlocks Delivered — only the uploaded document does (Q6)", () => {
    // No k2_photo → stays at the k2 step regardless of any historical ack.
    expect(footerStage(stop({ pod_photo: "x", do_uploaded: true }), { isK2: true })).toBe("k2");
  });

  it("K2 is checked only on K2 stops — a non-K2 stop never sees the k2 step", () => {
    expect(footerStage(stop({ pod_photo: "x", k2_photo: null }), { isK2: false })).toBe("delivered");
  });

  it("offline: queued arrival unlocks the POD step; queued photo advances the ladder", () => {
    expect(footerStage(stop({ status: "pending" }), { isK2: false, arrivedQueued: true })).toBe("pod");
    expect(footerStage(stop(), { isK2: false, podQueued: true })).toBe("delivered");
    // …but a queued photo still can't skip the K2 upload on a K2 stop.
    expect(footerStage(stop(), { isK2: true, podQueued: true })).toBe("k2");
  });

  it("delivered / queued-delivered stops have no footer action", () => {
    expect(footerStage(stop({ status: "delivered" }), { isK2: false })).toBeNull();
    expect(footerStage(stop({ pod_photo: "x" }), { isK2: false, deliveryQueued: true })).toBeNull();
  });
});

describe("waitingForDelivered — the Q1 re-point banner condition", () => {
  it("fires for a stop whose POD is uploaded but Delivered untapped", () => {
    expect(waitingForDelivered(stop({ pod_photo: "x" }), { isK2: false })).toBe(true);
  });

  it("fires for a K2 stop stuck before its form — the stop is still unfinished", () => {
    expect(waitingForDelivered(stop({ pod_photo: "x" }), { isK2: true })).toBe(true);
  });

  it("silent before the POD exists, after Delivered, and while the delivery is queued offline", () => {
    expect(waitingForDelivered(stop(), { isK2: false })).toBe(false);
    expect(waitingForDelivered(stop({ status: "delivered", pod_photo: "x" }), { isK2: false })).toBe(false);
    expect(waitingForDelivered(stop({ pod_photo: "x" }), { isK2: false, deliveryQueued: true })).toBe(false);
  });
});
