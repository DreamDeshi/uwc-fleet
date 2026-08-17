import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma", () => ({
  prisma: { consignee: { updateMany: vi.fn() } },
}));

import { prisma } from "../src/lib/prisma";
import { geocodeNewConsignee } from "../src/lib/geocodeConsignee";

/**
 * THE WITH-KEY PATH — the one CI cannot exercise.
 *
 * ⚠ WHY THIS FILE EXISTS. CI has no GOOGLE_MAPS_KEY, so the integration tier
 * runs `geocodeNewConsignee` as the MISCONFIGURED case, every time, forever.
 * That is correct and it is what `consigneeCoverage.test.ts` now asserts — but
 * it means the GOOD path has no coverage there at all, and a regression in it
 * would be invisible to the tier that looks most like production.
 *
 * The pieces were already unit-tested (`buildQuery`, `geocodeStoreFields`).
 * What was covered NOWHERE is the assembled behaviour: call the provider, then
 * write what came back, fill-only. That gap predates the failure-surfacing
 * work — CI never had a key — but that work is what made it visible, so it is
 * closed here rather than noted and forgotten.
 *
 * `fetch` and Prisma are both stubbed, so this needs no key, no network and no
 * database.
 */
const KEY = "test-key-not-a-real-one";
const CONSIGNEE = {
  id: "c-1",
  address_1: "Lot 44, Jalan Perusahaan 3",
  address_2: null,
  area: "Sungai Petani",
  state: "Kedah",
  postal_code: "08000",
};

function googleReturns(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => body }) as unknown as Response)
  );
}

const ok = (locationType: string, lat = 5.6494, lng = 100.4881) => ({
  status: "OK",
  results: [{ geometry: { location: { lat, lng }, location_type: locationType } }],
});

describe("geocodeNewConsignee — WITH a key", () => {
  beforeEach(() => {
    vi.mocked(prisma.consignee.updateMany).mockReset();
    vi.mocked(prisma.consignee.updateMany).mockResolvedValue({ count: 1 } as never);
    process.env.GOOGLE_MAPS_KEY = KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_MAPS_KEY;
  });

  it("writes the coordinate a successful lookup returned", async () => {
    googleReturns(ok("ROOFTOP"));
    await geocodeNewConsignee(CONSIGNEE);

    expect(prisma.consignee.updateMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.consignee.updateMany).mock.calls[0][0] as any;
    expect(call.data).toEqual({
      latitude: 5.6494,
      longitude: 100.4881,
      geocode_match_type: "ROOFTOP",
    });
  });

  it("writes a ROAD-level coordinate too — the whole point of the widened gate", async () => {
    // Before Aug 2026 this stored NULL and the consignee navigated to a zone
    // centroid up to 26.94 km away.
    googleReturns(ok("GEOMETRIC_CENTER", 5.3, 100.4));
    await geocodeNewConsignee(CONSIGNEE);

    const call = vi.mocked(prisma.consignee.updateMany).mock.calls[0][0] as any;
    expect(call.data.latitude).toBe(5.3);
    expect(call.data.geocode_match_type).toBe("GEOMETRIC_CENTER");
  });

  it("is FILL-ONLY, so it can never overwrite a position that arrived meanwhile", async () => {
    // An admin fix, a batch run or the self-heal may land between the consignee
    // being created and this fire-and-forget call completing.
    googleReturns(ok("ROOFTOP"));
    await geocodeNewConsignee(CONSIGNEE);

    const call = vi.mocked(prisma.consignee.updateMany).mock.calls[0][0] as any;
    expect(call.where).toMatchObject({ id: "c-1", latitude: null, longitude: null });
  });

  it("never sends the company name to the provider", async () => {
    // Multi-site and ambiguous — a documented rule of the query builder, worth
    // pinning at the boundary where the request is actually made.
    googleReturns(ok("ROOFTOP"));
    await geocodeNewConsignee({ ...CONSIGNEE, ...({ company_name: "SECRET SDN BHD" } as object) });

    const url = String(vi.mocked(globalThis.fetch).mock.calls[0][0]);
    expect(url).not.toContain("SECRET");
    expect(decodeURIComponent(url)).toContain("Jalan Perusahaan 3");
  });

  it("records ZERO_RESULTS with no coordinates, rather than inventing one", async () => {
    googleReturns({ status: "ZERO_RESULTS" });
    await geocodeNewConsignee(CONSIGNEE);

    const call = vi.mocked(prisma.consignee.updateMany).mock.calls[0][0] as any;
    expect(call.data).toEqual({
      latitude: null,
      longitude: null,
      geocode_match_type: "ZERO_RESULTS",
    });
  });

  it("records ERROR when the call throws, and never rethrows into the request", async () => {
    // Creation must not fail because geocoding did. The verdict write is what
    // stops a broken lookup from looking like one that never ran.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      })
    );
    // 2 attempts, then RETRY_EXHAUSTED — a thrown fetch is caught and retried
    // inside googleGeocode, so the verdict is the exhaustion, not "ERROR".
    await expect(geocodeNewConsignee(CONSIGNEE)).resolves.toBeUndefined();

    const call = vi.mocked(prisma.consignee.updateMany).mock.calls[0][0] as any;
    expect(call.data.latitude).toBeNull();
    expect(call.data.geocode_match_type).toBe("RETRY_EXHAUSTED");
  });
});

describe("geocodeNewConsignee — WITHOUT a key", () => {
  beforeEach(() => {
    vi.mocked(prisma.consignee.updateMany).mockReset();
    vi.mocked(prisma.consignee.updateMany).mockResolvedValue({ count: 1 } as never);
    delete process.env.GOOGLE_MAPS_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records NO_API_KEY and never calls the provider", async () => {
    // This is the case CI runs on every integration run. It used to be a bare
    // `return`, which left the row indistinguishable from one nobody had tried.
    googleReturns(ok("ROOFTOP"));
    await geocodeNewConsignee(CONSIGNEE);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    const call = vi.mocked(prisma.consignee.updateMany).mock.calls[0][0] as any;
    expect(call.data).toEqual({ geocode_match_type: "NO_API_KEY" });
    expect(call.where).toMatchObject({ latitude: null, longitude: null });
  });
});
