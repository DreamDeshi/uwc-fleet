import { describe, it, expect, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { api, prisma, resetDb, loginAs, auth, ADMIN } from "./helpers/harness";
import { userIdByPhone } from "./helpers/flow";

/**
 * ADMIN USER MANAGEMENT (Part B): admin-side identity edit (PATCH /users/:id),
 * disable guards on /approve, and the admin password reset (POST
 * /auth/forgot-password). Acts on a throwaway target user (recreated each test)
 * so the seeded logins other files depend on are never touched.
 */

const TARGET = { phone: "+60188881001", password: "TargetPass1" };
let targetId: string;

async function createTarget() {
  const password_hash = await bcrypt.hash(TARGET.password, 10);
  const t = await prisma.user.create({
    data: {
      phone: TARGET.phone,
      password_hash,
      name: "B Target",
      employee_number: "BTEST-1",
      role: "requestor",
      status: "active",
    },
  });
  targetId = t.id;
}

const patchUser = (token: string, id: string, body: object) =>
  api().patch(`/api/v1/users/${id}`).set(auth(token)).send(body);
const setStatus = (token: string, id: string, status: string) =>
  api().patch(`/api/v1/users/${id}/approve`).set(auth(token)).send({ status });
const setRole = (token: string, id: string, role: string) =>
  api().patch(`/api/v1/users/${id}/role`).set(auth(token)).send({ role });
const resetPassword = (token: string, user_id: string, new_password: string) =>
  api().post("/api/v1/auth/forgot-password").set(auth(token)).send({ user_id, new_password });

describe("admin user management", () => {
  beforeEach(async () => {
    await resetDb(); // truncates AuditLog too
    // Drop the previous throwaway target (audit rows already gone) and remake it.
    if (targetId) {
      await prisma.user.deleteMany({ where: { id: targetId } });
    }
    await createTarget();
  });
  afterAll(async () => {
    if (targetId) await prisma.user.deleteMany({ where: { id: targetId } });
    await prisma.$disconnect();
  });

  // ── Identity edit (PATCH /users/:id) ──────────────────────────────────────
  it("admin edits a user's name → 200, persisted, audited", async () => {
    const admin = await loginAs(ADMIN);
    const res = await patchUser(admin, targetId, { name: "Renamed By Admin" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed By Admin");
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: targetId, action: { startsWith: "user.admin_update" } },
    });
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(await userIdByPhone(ADMIN.phone));
    expect(audit!.action).toContain("name B Target→Renamed By Admin");
  });

  it("admin changes a user's phone (normalized, unique) → 200; the user logs in with it", async () => {
    const admin = await loginAs(ADMIN);
    const res = await patchUser(admin, targetId, { phone: "017-777 0001" });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe("+60177770001"); // normalized
    await expect(loginAs({ phone: "+60177770001", password: TARGET.password })).resolves.toBeTruthy();
  });

  // ⚠ THE TRAIL ON A LOGIN IDENTITY. This endpoint is the only one that can
  // rewrite the field users log in WITH, and it used to audit a bare
  // "user.admin_update" — so after a swap there was no record of the number an
  // account previously had. The six seeded drivers still carry placeholder
  // phones, so "who was +60100000103?" is about to be a real question.
  it("records the OLD → NEW phone in the audit trail", async () => {
    const admin = await loginAs(ADMIN);
    const res = await patchUser(admin, targetId, { phone: "017-777 0002" });
    expect(res.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: targetId, action: { startsWith: "user.admin_update" } },
      orderBy: { timestamp: "desc" },
    });
    // The OLD number is the whole point — without it the row proves only that
    // something changed, not what it was.
    expect(audit!.action).toContain(`phone ${TARGET.phone}→+60177770002`);
  });

  it("logs the NORMALIZED phone, not the raw input", async () => {
    // Or the trail would not match the value actually stored in the column.
    const admin = await loginAs(ADMIN);
    await patchUser(admin, targetId, { phone: "017-777 0003" });
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: targetId, action: { startsWith: "user.admin_update" } },
      orderBy: { timestamp: "desc" },
    });
    expect(audit!.action).toContain("→+60177770003");
    expect(audit!.action).not.toContain("017-777 0003");
  });

  it("records every changed identity field in one row", async () => {
    const admin = await loginAs(ADMIN);
    await patchUser(admin, targetId, { name: "Multi Change", phone: "017-777 0004" });
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: targetId, action: { startsWith: "user.admin_update" } },
      orderBy: { timestamp: "desc" },
    });
    expect(audit!.action).toContain("name B Target→Multi Change");
    expect(audit!.action).toContain(`phone ${TARGET.phone}→+60177770004`);
  });

  it("does not fabricate a change when the value is unchanged", async () => {
    // A no-op PATCH must not leave a row claiming an identity moved — that
    // would poison the trail it exists to provide.
    const admin = await loginAs(ADMIN);
    await patchUser(admin, targetId, { name: "B Target" });
    const audit = await prisma.auditLog.findFirst({
      where: { record_id: targetId, action: { startsWith: "user.admin_update" } },
      orderBy: { timestamp: "desc" },
    });
    expect(audit!.action).toBe("user.admin_update (no change)");
  });

  it("rejects a phone already used by another account → 409", async () => {
    const admin = await loginAs(ADMIN);
    const res = await patchUser(admin, targetId, { phone: ADMIN.phone });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PHONE_ALREADY_REGISTERED");
  });

  it("rejects an invalid phone → 400 INVALID_PHONE", async () => {
    const admin = await loginAs(ADMIN);
    const res = await patchUser(admin, targetId, { phone: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PHONE");
  });

  it("rejects an unknown department → 400 DEPARTMENT_NOT_FOUND", async () => {
    const admin = await loginAs(ADMIN);
    const res = await patchUser(admin, targetId, { department_id: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DEPARTMENT_NOT_FOUND");
  });

  it("unknown user → 404", async () => {
    const admin = await loginAs(ADMIN);
    expect((await patchUser(admin, "no-such-id", { name: "x" })).status).toBe(404);
  });

  it("is admin-only — a non-admin is forbidden (403)", async () => {
    const target = await loginAs(TARGET);
    expect((await patchUser(target, targetId, { name: "x" })).status).toBe(403);
  });

  // ── Disable guards (/approve) ─────────────────────────────────────────────
  it("admin cannot disable their own account → 400 CANNOT_DISABLE_SELF", async () => {
    const admin = await loginAs(ADMIN);
    const adminId = await userIdByPhone(ADMIN.phone);
    const res = await setStatus(admin, adminId, "disabled");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CANNOT_DISABLE_SELF");
    // Untouched.
    expect((await prisma.user.findUnique({ where: { id: adminId } }))!.status).toBe("active");
  });

  it("disabling a non-last admin is allowed → 200", async () => {
    const admin = await loginAs(ADMIN);
    await setRole(admin, targetId, "admin"); // now two admins exist
    const res = await setStatus(admin, targetId, "disabled");
    expect(res.status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: targetId } }))!.status).toBe("disabled");
  });

  // ── Admin password reset (POST /auth/forgot-password) ─────────────────────
  it("admin resets a user's password → 200; new works, old fails; audited", async () => {
    const admin = await loginAs(ADMIN);
    const res = await resetPassword(admin, targetId, "ResetByAdmin1");
    expect(res.status).toBe(200);

    await expect(loginAs({ phone: TARGET.phone, password: "ResetByAdmin1" })).resolves.toBeTruthy();
    await expect(loginAs(TARGET)).rejects.toThrow(); // old password no longer valid

    const audit = await prisma.auditLog.findFirst({
      where: { record_id: targetId, action: "user.password_reset_by_admin" },
    });
    expect(audit).not.toBeNull();
  });

  it("password reset is admin-only — a non-admin is forbidden (403)", async () => {
    const target = await loginAs(TARGET);
    expect((await resetPassword(target, targetId, "Whatever123")).status).toBe(403);
  });
});
