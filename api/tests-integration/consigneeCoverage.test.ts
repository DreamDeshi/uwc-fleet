import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { api, auth, prisma, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";

/**
 * GET /consignees/coverage, AND THE THING THAT FEEDS IT.
 *
 * The endpoint is the admin's only signal that the map data has holes. It had
 * no test at all, and the loop it sits in was broken at the other end: an admin
 * correcting a wrong address left the OLD building's coordinate on the row, so
 * the consignee still read as "covered" and the driver's Navigate still opened
 * the old place. The corrected address existed only as text.
 *
 * Both ends are asserted here, in one file, because either alone passes while
 * the pair is useless.
 *
 * DELTAS, NOT ABSOLUTES: the test DB carries 1,561 seeded consignees and
 * resetDb deliberately keeps them (they are master data). Every assertion below
 * is a before/after difference on a consignee this file created, so it does not
 * care what the seed's baseline is.
 */
describe("GET /consignees/coverage", () => {
  let admin = "", driver = "", requestor = "";
  const made: string[] = [];

  beforeAll(async () => {
    [admin, driver, requestor] = await Promise.all([loginAs(ADMIN), loginAs(DRIVER), loginAs(REQUESTOR)]);
  });
  afterEach(async () => {
    if (made.length) await prisma.consignee.deleteMany({ where: { id: { in: made.splice(0) } } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  type Coverage = {
    total_active: number;
    missing_coords: number;
    never_geocoded: number;
    partial_coords: number;
  };
  const coverage = async (): Promise<Coverage> => {
    const res = await api().get("/api/v1/consignees/coverage").set(auth(admin));
    expect(res.status, res.text).toBe(200);
    return res.body;
  };

  /** A consignee with a REAL rooftop geocode — the state Navigate trusts. */
  async function geocodedConsignee(over: Record<string, unknown> = {}) {
    const c = await prisma.consignee.create({
      data: {
        company_name: `Coverage Fixture ${made.length} ${Date.now()}`,
        zone_code: "K1",
        is_active: true,
        address_1: "12 Jalan Perusahaan",
        area: "KULIM",
        state: "KEDAH",
        postal_code: "09000",
        latitude: 5.3654,
        longitude: 100.5612,
        geocode_match_type: "ROOFTOP",
        ...over,
      },
    });
    made.push(c.id);
    return c;
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    api().patch(`/api/v1/consignees/${id}`).set(auth(admin)).send({ force: true, ...body });

  it("is admin-only", async () => {
    for (const [who, token] of [["driver", driver], ["requestor", requestor]] as const) {
      const res = await api().get("/api/v1/consignees/coverage").set(auth(token));
      expect(res.status, `${who} got ${res.status}`).toBe(403);
    }
    expect((await api().get("/api/v1/consignees/coverage")).status).toBe(401);
  });

  it("the four counts are internally consistent", async () => {
    const c = await coverage();
    expect(c.total_active).toBeGreaterThan(0);
    expect(c.missing_coords).toBeLessThanOrEqual(c.total_active);
    // never_geocoded is a SUBSET of missing_coords, not a separate population.
    expect(c.never_geocoded).toBeLessThanOrEqual(c.missing_coords);
    expect(c.never_geocoded).toBeGreaterThanOrEqual(0);
    // Derived by subtraction from two unsynchronised counts — never negative.
    expect(c.partial_coords).toBeGreaterThanOrEqual(0);
  });

  it("CORRECTING AN ADDRESS puts the consignee back in the queue", async () => {
    // The headline. Before: covered, and Navigate opens 5.3654/100.5612.
    const c = await geocodedConsignee();
    const before = await coverage();

    const res = await patch(c.id, { address_1: "500 Lorong Industri" });
    expect(res.status, res.text).toBe(200);

    const row = await prisma.consignee.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.address_1).toBe("500 Lorong Industri");
    expect(row.latitude, "the old building's coordinate survived the correction").toBeNull();
    expect(row.longitude).toBeNull();
    expect(row.geocode_match_type).toBeNull();

    const after = await coverage();
    expect(after.total_active).toBe(before.total_active); // still active, still counted
    expect(after.missing_coords - before.missing_coords).toBe(1);
    // And it lands in the ACTIONABLE bucket, which is the whole point: the
    // admin is told a geocode run will fix this one.
    expect(after.never_geocoded - before.never_geocoded).toBe(1);
  });

  it("the audit log records that a position was discarded", async () => {
    // After the edit the row cannot show a coordinate was ever there, so the
    // log is the only place a "why is Navigate different today" question can be
    // answered.
    const c = await geocodedConsignee();
    await patch(c.id, { postal_code: "11900" });
    const log = await prisma.auditLog.findFirst({
      where: { table_name: "Consignee", record_id: c.id },
      orderBy: { timestamp: "desc" },
    });
    expect(log?.action).toContain("geocode cleared (address moved)");
  });

  it("a RENAME keeps the position — the building has not moved", async () => {
    const c = await geocodedConsignee();
    const before = await coverage();
    const res = await patch(c.id, { company_name: `Renamed Fixture ${Date.now()}` });
    expect(res.status, res.text).toBe(200);

    const row = await prisma.consignee.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.latitude).toBe(5.3654);
    expect((await coverage()).missing_coords).toBe(before.missing_coords);
  });

  it("ASKED AND DECLINED counts as missing but NOT as never geocoded", async () => {
    // scripts/geocode-google.ts writes NULL coords with the raw location_type
    // when Google answers with a centroid. Re-running returns the same verdict,
    // so suggesting a run for these is advice that cannot work.
    const before = await coverage();
    await geocodedConsignee({
      latitude: null,
      longitude: null,
      geocode_match_type: "APPROXIMATE",
    });
    const after = await coverage();
    expect(after.missing_coords - before.missing_coords).toBe(1);
    expect(after.never_geocoded - before.never_geocoded, "a declined lookup is not actionable").toBe(0);
  });

  it("a NEW consignee is never-geocoded, and therefore actionable", async () => {
    const before = await coverage();
    const res = await api()
      .post("/api/v1/consignees")
      .set(auth(requestor))
      .send({
        company_name: `Self Add Fixture ${Date.now()}`,
        zone_code: "K1",
        address_1: "1 Jalan Baharu",
        force: true,
      });
    expect(res.status, res.text).toBe(201);
    made.push(res.body.id);

    const after = await coverage();
    expect(after.never_geocoded - before.never_geocoded).toBe(1);
  });

  it("a half-null row is reported as a data anomaly, not as missing", async () => {
    // Nothing writes one coordinate without the other — both scripts write the
    // pair. So this canary firing means something has gone wrong outside the
    // known writers, which is exactly why it is surfaced separately.
    const before = await coverage();
    await geocodedConsignee({ longitude: null });
    const after = await coverage();
    expect(after.partial_coords - before.partial_coords).toBe(1);
    expect(after.missing_coords - before.missing_coords, "half-null is not healable").toBe(0);
  });

  it("a DEACTIVATED consignee leaves every count", async () => {
    const c = await geocodedConsignee({ latitude: null, longitude: null, geocode_match_type: null });
    const before = await coverage();
    const res = await patch(c.id, { is_active: false });
    expect(res.status, res.text).toBe(200);
    const after = await coverage();
    expect(before.total_active - after.total_active).toBe(1);
    expect(before.missing_coords - after.missing_coords).toBe(1);
    expect(before.never_geocoded - after.never_geocoded).toBe(1);
  });
});
