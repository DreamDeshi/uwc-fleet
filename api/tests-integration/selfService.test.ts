import { describe, it, expect, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { api, prisma, resetDb, loginAs, auth } from "./helpers/harness";

/**
 * SELF-SERVICE account management (Part A): a logged-in user edits their OWN
 * profile (name / department) and password. Operates on a dedicated throwaway
 * account so it never contaminates the seeded logins other test files rely on.
 */

const SELF = { phone: "+60188880001", password: "SelfTest123" };

async function ensureSelfUser() {
  const password_hash = await bcrypt.hash(SELF.password, 10);
  await prisma.user.upsert({
    where: { phone: SELF.phone },
    update: { password_hash, name: "Self Tester", role: "requestor", status: "active", department_id: null },
    create: { phone: SELF.phone, password_hash, name: "Self Tester", role: "requestor", status: "active" },
  });
}

const patchMe = (token: string, body: unknown) =>
  api().patch("/api/v1/users/me").set(auth(token)).send(body);
const patchPassword = (token: string, body: unknown) =>
  api().patch("/api/v1/users/me/password").set(auth(token)).send(body);

describe("self-service /users/me", () => {
  beforeEach(async () => {
    await resetDb(); // truncates AuditLog too — each test starts with a clean audit trail
    await ensureSelfUser();
  });
  afterAll(async () => {
    const u = await prisma.user.findUnique({ where: { phone: SELF.phone } });
    if (u) {
      await prisma.auditLog.deleteMany({ where: { user_id: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
    }
    await prisma.$disconnect();
  });

  it("updates own display name → 200, persisted, audited", async () => {
    const token = await loginAs(SELF);
    const res = await patchMe(token, { name: "Renamed Tester" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed Tester");

    const inDb = await prisma.user.findUnique({ where: { phone: SELF.phone } });
    expect(inDb!.name).toBe("Renamed Tester");
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: inDb!.id, action: "user.self_update" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(inDb!.id); // self-attributed
  });

  it("updates own department to a valid one → 200", async () => {
    const dept = await prisma.department.findFirst();
    const token = await loginAs(SELF);
    const res = await patchMe(token, { department_id: dept!.id });
    expect(res.status).toBe(200);
    expect(res.body.department.id).toBe(dept!.id);
    const inDb = await prisma.user.findUnique({ where: { phone: SELF.phone } });
    expect(inDb!.department_id).toBe(dept!.id);
  });

  it("rejects an unknown department → 400 DEPARTMENT_NOT_FOUND", async () => {
    const token = await loginAs(SELF);
    const res = await patchMe(token, { department_id: "no-such-dept" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DEPARTMENT_NOT_FOUND");
  });

  it("silently ignores role/status/phone — no self-escalation", async () => {
    const token = await loginAs(SELF);
    const res = await patchMe(token, {
      name: "Sneaky",
      role: "admin",
      status: "disabled",
      phone: "+60111111111",
    });
    expect(res.status).toBe(200); // stripped-unknown keys → name applied, rest dropped
    const inDb = await prisma.user.findUnique({ where: { phone: SELF.phone } });
    expect(inDb!.name).toBe("Sneaky");
    expect(inDb!.role).toBe("requestor"); // NOT admin
    expect(inDb!.status).toBe("active"); // NOT disabled
    expect(inDb!.phone).toBe(SELF.phone); // login ID unchanged
  });

  it("rejects an empty update → 400", async () => {
    const token = await loginAs(SELF);
    expect((await patchMe(token, {})).status).toBe(400);
  });

  it("password: wrong current → 400 INVALID_CURRENT_PASSWORD", async () => {
    const token = await loginAs(SELF);
    const res = await patchPassword(token, { current_password: "WrongPass9", new_password: "BrandNew123" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURRENT_PASSWORD");
  });

  it("password: too-short new → 400 validation", async () => {
    const token = await loginAs(SELF);
    expect((await patchPassword(token, { current_password: SELF.password, new_password: "abc" })).status).toBe(400);
  });

  it("password: same as current → 400 PASSWORD_UNCHANGED", async () => {
    const token = await loginAs(SELF);
    const res = await patchPassword(token, { current_password: SELF.password, new_password: SELF.password });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PASSWORD_UNCHANGED");
  });

  it("password: correct current → 200; new logs in, old fails; audited", async () => {
    const token = await loginAs(SELF);
    const res = await patchPassword(token, { current_password: SELF.password, new_password: "BrandNew123" });
    expect(res.status).toBe(200);

    // New password works…
    await expect(loginAs({ phone: SELF.phone, password: "BrandNew123" })).resolves.toBeTruthy();
    // …old one no longer does.
    await expect(loginAs({ phone: SELF.phone, password: SELF.password })).rejects.toThrow();

    const inDb = await prisma.user.findUnique({ where: { phone: SELF.phone } });
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: inDb!.id, action: "user.self_password_change" },
    });
    expect(audit).not.toBeNull();
  });
});
