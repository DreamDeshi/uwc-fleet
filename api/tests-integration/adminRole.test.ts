import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, prisma, resetDb, loginAs, auth, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone } from "./helpers/flow";

/**
 * ADMIN ROLE MANAGEMENT (PATCH /users/:id/role) — the in-app cure for the
 * single-admin SPOF. An existing admin can promote a trusted account to admin
 * (so access never hinges on one login) and demote again, with two guardrails:
 * the LAST active admin can't be demoted, and the driver↔non-driver truck
 * binding is kept consistent.
 */

const patchRole = (token: string, id: string, role: string) =>
  api().patch(`/api/v1/users/${id}/role`).set(auth(token)).send({ role });

/**
 * These tests promote/demote the SEEDED admin/requestor/driver — shared master
 * data that resetDb() does NOT restore (it upserts users with `update: {}`, and
 * even a re-seed leaves an existing account's role untouched by design). So we
 * put their canonical role/status/truck back before each test and once at the
 * end — otherwise a demoted admin / promoted requestor leaks across tests, runs,
 * and other integration files (which run serially, this one first).
 */
async function restoreSeededAccounts() {
  await prisma.user.update({
    where: { phone: ADMIN.phone },
    data: { role: "admin", status: "active", assigned_truck_plate: null },
  });
  await prisma.user.update({
    where: { phone: REQUESTOR.phone },
    data: { role: "requestor", status: "active", assigned_truck_plate: null },
  });
  await prisma.user.update({
    where: { phone: DRIVER.phone },
    data: { role: "driver", status: "active", assigned_truck_plate: "PLX 2406" },
  });
}

describe("PATCH /users/:id/role", () => {
  beforeEach(async () => {
    await resetDb();
    await restoreSeededAccounts();
  });
  afterAll(async () => {
    await restoreSeededAccounts();
    await prisma.$disconnect();
  });

  it("is admin-only — a requestor is forbidden (403)", async () => {
    const requestor = await loginAs(REQUESTOR);
    const adminId = await userIdByPhone(ADMIN.phone);
    const res = await patchRole(requestor, adminId, "requestor");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("is admin-only — a driver is forbidden (403)", async () => {
    const driver = await loginAs(DRIVER);
    const adminId = await userIdByPhone(ADMIN.phone);
    expect((await patchRole(driver, adminId, "requestor")).status).toBe(403);
  });

  it("admin promotes a requestor to admin → 200, persisted, audited, and the promotee gains admin access", async () => {
    const admin = await loginAs(ADMIN);
    const adminId = await userIdByPhone(ADMIN.phone);
    const reqId = await userIdByPhone(REQUESTOR.phone);

    const res = await patchRole(admin, reqId, "admin");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");

    const inDb = await prisma.user.findUnique({ where: { id: reqId } });
    expect(inDb!.role).toBe("admin");

    const audit = await prisma.auditLog.findFirst({
      where: { record_id: reqId, action: "user.role_changed:requestor->admin" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(adminId); // attributed to the acting admin

    // The promotee can now reach an admin-only endpoint with their OWN login.
    const promoted = await loginAs(REQUESTOR);
    expect((await api().get("/api/v1/users").set(auth(promoted))).status).toBe(200);
  });

  it("refuses to demote the LAST active admin → 409 LAST_ADMIN", async () => {
    const admin = await loginAs(ADMIN);
    const adminId = await userIdByPhone(ADMIN.phone);

    const res = await patchRole(admin, adminId, "requestor");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("LAST_ADMIN");

    // Unchanged in the DB.
    expect((await prisma.user.findUnique({ where: { id: adminId } }))!.role).toBe("admin");
  });

  it("with a SECOND admin present, the original admin CAN be demoted → 200 (SPOF removed)", async () => {
    const admin = await loginAs(ADMIN);
    const adminId = await userIdByPhone(ADMIN.phone);
    const reqId = await userIdByPhone(REQUESTOR.phone);

    // Two admins now exist.
    expect((await patchRole(admin, reqId, "admin")).status).toBe(200);

    // Demoting the original is allowed because another active admin remains.
    const res = await patchRole(admin, adminId, "requestor");
    expect(res.status).toBe(200);

    expect((await prisma.user.findUnique({ where: { id: adminId } }))!.role).toBe("requestor");
    expect((await prisma.user.findUnique({ where: { id: reqId } }))!.role).toBe("admin");
  });

  it("moving a driver off the driver role releases their 1:1 truck slot", async () => {
    const admin = await loginAs(ADMIN);
    const driverId = await userIdByPhone(DRIVER.phone); // PLX 2406, assigned_truck_plate set

    const before = await prisma.user.findUnique({ where: { id: driverId } });
    expect(before!.assigned_truck_plate).toBe("PLX 2406");

    const res = await patchRole(admin, driverId, "requestor");
    expect(res.status).toBe(200);

    const after = await prisma.user.findUnique({ where: { id: driverId } });
    expect(after!.role).toBe("requestor");
    expect(after!.assigned_truck_plate).toBeNull(); // slot freed for a future driver
  });

  it("refuses to make a truckless account a driver → 400 DRIVER_NEEDS_TRUCK", async () => {
    const admin = await loginAs(ADMIN);
    const reqId = await userIdByPhone(REQUESTOR.phone); // requestor has no truck

    const res = await patchRole(admin, reqId, "driver");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DRIVER_NEEDS_TRUCK");
  });

  it("unknown user → 404 USER_NOT_FOUND", async () => {
    const admin = await loginAs(ADMIN);
    const res = await patchRole(admin, "no-such-id", "admin");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USER_NOT_FOUND");
  });

  it("rejects an invalid role value → 400 (validation)", async () => {
    const admin = await loginAs(ADMIN);
    const adminId = await userIdByPhone(ADMIN.phone);
    expect((await patchRole(admin, adminId, "superuser")).status).toBe(400);
  });

  it("a no-op role change writes no audit row", async () => {
    const admin = await loginAs(ADMIN);
    const adminId = await userIdByPhone(ADMIN.phone);
    const before = await prisma.auditLog.count();

    const res = await patchRole(admin, adminId, "admin"); // already admin
    expect(res.status).toBe(200);
    expect(await prisma.auditLog.count()).toBe(before);
  });
});
