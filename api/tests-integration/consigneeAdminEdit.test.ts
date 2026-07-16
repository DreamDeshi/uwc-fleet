import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, resetDb, loginAs, api, auth, ADMIN } from "./helpers/harness";

/**
 * Admin consignee address editing — Mr. Teh 16 Jul 2026: "can help to let
 * admin add new consignee, address,postcode, also to let admin amend the
 * existing address, postal code." The PATCH previously accepted only
 * name/zone/is_active; it now takes the address/contact details too. Empty
 * string clears a field (stored null); the audit row names what changed.
 */
describe("PATCH /consignees/:id — address details", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedConsignee() {
    return prisma.consignee.create({
      data: {
        company_name: "ADDRESS EDIT TEST SDN BHD",
        zone_code: "P1",
        address_1: "OLD LINE 1",
        postal_code: "10000",
      },
    });
  }

  it("amends address + postcode, clears with empty string, and audits the field names", async () => {
    const admin = await loginAs(ADMIN);
    const c = await seedConsignee();

    const res = await api()
      .patch(`/api/v1/consignees/${c.id}`)
      .set(auth(admin))
      .send({ address_1: "PLOT 88, LORONG PERUSAHAAN 4", address_2: "PRAI INDUSTRIAL ESTATE", postal_code: "13600" });
    expect(res.status).toBe(200);

    let row = await prisma.consignee.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.address_1).toBe("PLOT 88, LORONG PERUSAHAAN 4");
    expect(row.address_2).toBe("PRAI INDUSTRIAL ESTATE");
    expect(row.postal_code).toBe("13600");

    // Zone and name untouched by a details-only patch.
    expect(row.zone_code).toBe("P1");
    expect(row.company_name).toBe("ADDRESS EDIT TEST SDN BHD");

    // Audit row names the changed fields behind the stable prefix.
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: c.id, action: { startsWith: "consignee.updated" } },
      orderBy: { timestamp: "desc" },
    });
    expect(audit?.action).toContain("details:");
    expect(audit?.action).toContain("address_1");
    expect(audit?.action).toContain("postal_code");

    // Empty string clears (same optional semantics as the create route).
    const clear = await api()
      .patch(`/api/v1/consignees/${c.id}`)
      .set(auth(admin))
      .send({ address_2: "" });
    expect(clear.status).toBe(200);
    row = await prisma.consignee.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.address_2).toBeNull();
    expect(row.address_1).toBe("PLOT 88, LORONG PERUSAHAAN 4"); // untouched
  });

  it("list payload now carries the address fields (the editor prefills from it)", async () => {
    const admin = await loginAs(ADMIN);
    await seedConsignee();

    const res = await api()
      .get("/api/v1/consignees?search=ADDRESS EDIT TEST")
      .set(auth(admin));
    expect(res.status).toBe(200);
    const hit = res.body.find((r: { company_name_full?: string }) =>
      r.company_name_full?.startsWith("ADDRESS EDIT TEST")
    );
    expect(hit).toBeTruthy();
    expect(hit.address_1).toBe("OLD LINE 1");
    expect(hit.postal_code).toBe("10000");
  });
});
