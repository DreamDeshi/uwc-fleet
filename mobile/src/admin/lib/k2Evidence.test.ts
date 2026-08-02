import { describe, it, expect } from "vitest";
import { k2ApprovalGaps, k2Evidence, type K2GateStop, type K2StopLike } from "./k2Evidence";
import { CUSTOMS_DOC_ZONE, CUSTOMS_DOC_AREA } from "../../lib/activeTripStage";

const K2_URL = "https://res.cloudinary.com/uwc/image/authenticated/s--sig--/uwc/k2/TKT-1-stop-1";

const stop = (over: Partial<K2StopLike> & { zone?: string; area?: string | null } = {}): K2StopLike => ({
  k2_photo: over.k2_photo ?? null,
  consignee: over.consignee ?? {
    zone_code: over.zone ?? CUSTOMS_DOC_ZONE,
    area: over.area === undefined ? CUSTOMS_DOC_AREA : over.area,
  },
});

describe("what the approving admin is told about a stop's K2", () => {
  it("offers the document when one was uploaded", () => {
    expect(k2Evidence(stop({ k2_photo: K2_URL }))).toBe("present");
  });

  it("flags a Bayan Lepas stop with no document", () => {
    expect(k2Evidence(stop())).toBe("missing");
  });

  it("says nothing for a stop that never needed one", () => {
    expect(k2Evidence(stop({ zone: "P2", area: "PERAI" }))).toBe("not_required");
    // P1 outside Bayan Lepas — the 29 Jul ruling gates the AREA, not the zone.
    expect(k2Evidence(stop({ area: "GEORGE TOWN" }))).toBe("not_required");
  });

  // ⚠ THE REGRESSION THIS FILE EXISTS TO PREVENT. If the zone rule were asked
  // FIRST, a document uploaded outside the expected area would be unopenable
  // and the admin would never learn it existed — the same "approving something
  // nobody can see" bug as IM9 itself, one level down. The rule has already
  // moved once (29 Jul: zone P1 → the Bayan Lepas area inside it), so rows
  // uploaded under the older reading are real.
  it("still offers a document stored outside the area that requires one", () => {
    expect(k2Evidence(stop({ k2_photo: K2_URL, zone: "P2", area: "PERAI" }))).toBe("present");
    expect(k2Evidence(stop({ k2_photo: K2_URL, area: "GEORGE TOWN" }))).toBe("present");
  });

  it("does not flag a stop whose area is blank", () => {
    // requiresCustomsDoc FAILS OPEN on an unknown area (owner, 29 Jul: "a
    // missing document is recoverable at POD approval; a stranded driver
    // isn't"). The admin view must not contradict the gate by demanding a
    // document the driver was never asked for.
    expect(k2Evidence(stop({ area: null }))).toBe("not_required");
    expect(k2Evidence(stop({ area: "" }))).toBe("not_required");
  });

  it("matches the real free-text area rows, not just the bare name", () => {
    // Live rows read "KAWASAN PERINDUSTRIAN BAYAN LEPAS" as often as the name.
    expect(k2Evidence(stop({ area: "Kawasan Perindustrian Bayan Lepas" }))).toBe("missing");
  });
});

// ── The Approve gate (owner ruling, 2 Aug 2026) ─────────────────────────────
// "Block Approve with a confirm — but only when the stop was actually delivered
// (upload gate should have run) and the document is missing. Don't block on a
// settled-undelivered stop, since no K2 was ever expected there."
const SETTLED = [{ current_state: "resolved", resolution: "resume", actions: [{ type: "verify" }] }];

const gateStop = (over: Partial<K2GateStop> & { area?: string | null } = {}): K2GateStop => ({
  status: over.status ?? "delivered",
  arrived_at: over.arrived_at ?? "2026-08-02T06:00:00.000Z",
  exceptions: over.exceptions,
  k2_photo: over.k2_photo ?? null,
  consignee: over.consignee ?? {
    zone_code: CUSTOMS_DOC_ZONE,
    area: over.area === undefined ? CUSTOMS_DOC_AREA : over.area,
  },
});

describe("which missing K2s block approval", () => {
  it("blocks a DELIVERED stop with no document", () => {
    // The upload gate stands directly in front of the Delivered tap, so this
    // combination should be unreachable — which is exactly why it is worth
    // stopping for rather than shrugging at.
    const gaps = k2ApprovalGaps([gateStop()]);
    expect(gaps.blocking).toHaveLength(1);
    expect(gaps.notExpected).toHaveLength(0);
  });

  // ⚠ THE RULING'S WHOLE POINT. A settled-undelivered stop is PAID and its K2
  // is absent — identical to the blocking case in the data. It must not block:
  // the driver never delivered, so the upload gate never ran and no document
  // was ever asked for. Blocking here would stop legitimate approvals dead.
  it("does not block a settled-undelivered stop, and names it separately", () => {
    const gaps = k2ApprovalGaps([gateStop({ status: "arrived", exceptions: SETTLED })]);
    expect(gaps.blocking).toHaveLength(0);
    expect(gaps.notExpected).toHaveLength(1);
  });

  it("keeps the two apart on a trip that has both", () => {
    const gaps = k2ApprovalGaps([
      gateStop({ status: "delivered" }),
      gateStop({ status: "arrived", exceptions: SETTLED }),
    ]);
    expect(gaps.blocking).toHaveLength(1);
    expect(gaps.blocking[0].status).toBe("delivered");
    expect(gaps.notExpected).toHaveLength(1);
    expect(gaps.notExpected[0].status).toBe("arrived");
  });

  it("ignores a stop that is neither delivered nor settled", () => {
    // Not on this invoice at all — an unpaid stop's missing document is not the
    // admin's business at the moment of approval, and surfacing it would put a
    // blocking dialog in front of every partial trip.
    const gaps = k2ApprovalGaps([gateStop({ status: "pending", arrived_at: null })]);
    expect(gaps.blocking).toHaveLength(0);
    expect(gaps.notExpected).toHaveLength(0);
  });

  it("does not block when the document is there", () => {
    expect(k2ApprovalGaps([gateStop({ k2_photo: K2_URL })]).blocking).toHaveLength(0);
  });

  it("does not block a delivered stop that never needed a K2", () => {
    // The common case by far — everything outside Bayan Lepas. If this ever
    // returns a gap, every approval in the fleet grows a confirm dialog.
    expect(
      k2ApprovalGaps([gateStop({ consignee: { zone_code: "P2", area: "PERAI" } })]).blocking
    ).toHaveLength(0);
  });

  it("has nothing to say about an empty trip", () => {
    expect(k2ApprovalGaps([])).toEqual({ blocking: [], notExpected: [] });
  });
});
