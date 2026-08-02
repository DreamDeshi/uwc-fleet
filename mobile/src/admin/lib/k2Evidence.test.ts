import { describe, it, expect } from "vitest";
import { k2Evidence, type K2StopLike } from "./k2Evidence";
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
