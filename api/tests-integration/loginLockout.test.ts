import { describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { api, prisma, resetDb, loginAs, auth, ADMIN } from "./helpers/harness";

/**
 * SC3 (second half): per-account login lockout, through the REAL /auth/login
 * route. `tests/loginLockout.test.ts` covers the decision rules; this covers the
 * wiring — that a lock is actually enforced, actually clears, and actually stops
 * the one thing it exists to stop.
 *
 * Runs on a dedicated throwaway account. The seeded logins are shared by every
 * other file in the suite, and locking one here would fail unrelated tests with
 * a 423 that looked nothing like its cause.
 *
 * ⚠ setup.ts sets LOGIN_LOCKOUT_MAX_ATTEMPTS=0 for the whole suite, which is
 * what keeps the other ~148 tests from tripping a lock on their wrong-password
 * paths. Every test here sets its own value and puts it back afterwards —
 * possible only because lockoutConfig() reads the environment at CALL time.
 */

const VICTIM = { phone: "+60188880009", password: "LockoutTester123" };
const MAX = 3;

async function ensureVictim() {
  const password_hash = await bcrypt.hash(VICTIM.password, 10);
  await prisma.user.upsert({
    where: { phone: VICTIM.phone },
    update: {
      password_hash,
      name: "Lockout Tester",
      role: "requestor",
      status: "active",
      failed_login_attempts: 0,
      locked_until: null,
    },
    create: {
      phone: VICTIM.phone,
      password_hash,
      name: "Lockout Tester",
      role: "requestor",
      status: "active",
    },
  });
}

const login = (password: string) =>
  api().post("/api/v1/auth/login").send({ phone: VICTIM.phone, password });

const readState = () =>
  prisma.user.findUniqueOrThrow({
    where: { phone: VICTIM.phone },
    select: { failed_login_attempts: true, locked_until: true },
  });

const ORIGINAL_MAX = process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS;

beforeEach(async () => {
  await resetDb();
  await ensureVictim();
  process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = String(MAX);
});

afterEach(() => {
  if (ORIGINAL_MAX === undefined) delete process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS;
  else process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = ORIGINAL_MAX;
});

describe("per-account login lockout", () => {
  it("counts failures and locks on the attempt that reaches the threshold", async () => {
    for (let i = 1; i < MAX; i++) {
      const res = await login("WrongPassword1");
      expect(res.status, `attempt ${i}`).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
      expect((await readState()).failed_login_attempts).toBe(i);
    }

    const locking = await login("WrongPassword1");
    expect(locking.status).toBe(423);
    expect(locking.body.error.code).toBe("ACCOUNT_LOCKED");
    expect((await readState()).locked_until).not.toBeNull();
  });

  // ⚠ THE ASSERTION THE WHOLE FEATURE RESTS ON. A lockout that yields to the
  // correct password stops nothing, because the correct password is precisely
  // what the attacker is searching for. If this ever goes green-by-accident the
  // feature is decorative.
  it("refuses the CORRECT password while locked", async () => {
    for (let i = 0; i < MAX; i++) await login("WrongPassword1");

    const res = await login(VICTIM.password);
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(res.body.accessToken).toBeUndefined();
  });

  it("a correct password below the threshold clears the counter", async () => {
    await login("WrongPassword1");
    await login("WrongPassword1");
    expect((await readState()).failed_login_attempts).toBe(2);

    expect((await login(VICTIM.password)).status).toBe(200);
    expect(await readState()).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  // The lock must heal by itself — an admin who is asleep cannot be the only
  // way a driver gets back into the app at 5am.
  it("an expired lock lets the user straight back in", async () => {
    for (let i = 0; i < MAX; i++) await login("WrongPassword1");
    expect((await login(VICTIM.password)).status).toBe(423);

    await prisma.user.update({
      where: { phone: VICTIM.phone },
      data: { locked_until: new Date(Date.now() - 1000) },
    });

    expect((await login(VICTIM.password)).status).toBe(200);
  });

  it("records exactly one audit row for the lock, not one per failure", async () => {
    for (let i = 0; i < MAX; i++) await login("WrongPassword1");

    const rows = await prisma.auditLog.findMany({ where: { action: "user.login_locked" } });
    expect(rows).toHaveLength(1);
  });

  // An unknown phone has no account to count against. It must also not become a
  // way to tell registered phones from unregistered ones by timing or by shape.
  it("an unknown phone is a plain 401 with no lockout state anywhere", async () => {
    const res = await api()
      .post("/api/v1/auth/login")
      .send({ phone: "+60188889999", password: "WhateverPass1" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(await readState()).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  it("an admin Setting row OVERRIDES the env var (Phase 5, 28 Aug 2026)", async () => {
    // The env var says 3 (this file's MAX, set in beforeEach). An admin sets a
    // DB override of 5 — the SAME wrong-password run that used to lock at
    // attempt 3 must now go all the way to attempt 5.
    const admin = await loginAs(ADMIN);
    const patch = await api()
      .patch("/api/v1/settings/security.login_lockout_max_attempts")
      .set(auth(admin))
      .send({ value: 5 });
    expect(patch.status).toBe(200);

    for (let i = 1; i < 5; i++) {
      const res = await login("WrongPassword1");
      expect(res.status, `attempt ${i} (DB override in effect)`).toBe(401); // NOT locked yet
    }
    const locking = await login("WrongPassword1");
    expect(locking.status).toBe(423); // locks on the 5th, per the DB override

    // Resetting the setting restores the env var's value (3) as the governing
    // one — proving the fallback chain, not just that the override works once.
    const del = await api()
      .delete("/api/v1/settings/security.login_lockout_max_attempts")
      .set(auth(admin));
    expect(del.status).toBe(200);
    await ensureVictim(); // fresh account — the one above is now locked
    for (let i = 1; i < MAX; i++) await login("WrongPassword1");
    expect((await login("WrongPassword1")).status).toBe(423); // back to 3
  });

  it("LOGIN_LOCKOUT_MAX_ATTEMPTS=0 disables it completely, touching neither column", async () => {
    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "0";

    for (let i = 0; i < MAX + 3; i++) {
      expect((await login("WrongPassword1")).status).toBe(401);
    }
    // Not merely "not locked" — the disabled path must not write at all, so a
    // run with the lockout off cannot leave state behind that bites a later run.
    expect(await readState()).toEqual({ failed_login_attempts: 0, locked_until: null });
    expect((await login(VICTIM.password)).status).toBe(200);
  });
});

describe("admin unlock", () => {
  const unlock = (token: string, id: string) =>
    api().post(`/api/v1/users/${id}/unlock`).set(auth(token));

  async function victimId(): Promise<string> {
    return (await prisma.user.findUniqueOrThrow({ where: { phone: VICTIM.phone } })).id;
  }

  it("ends a lock early and lets the user log in immediately", async () => {
    for (let i = 0; i < MAX; i++) await login("WrongPassword1");
    expect((await login(VICTIM.password)).status).toBe(423);

    const token = await loginAs(ADMIN);
    const res = await unlock(token, await victimId());
    expect(res.status).toBe(200);
    expect(res.body.locked_until).toBeNull();

    expect((await login(VICTIM.password)).status).toBe(200);
  });

  it("is idempotent — unlocking an account that is not locked is a no-op success", async () => {
    const token = await loginAs(ADMIN);
    const id = await victimId();

    expect((await unlock(token, id)).status).toBe(200);
    // and writes no audit row, because nothing happened
    expect(await prisma.auditLog.count({ where: { action: "user.login_unlocked" } })).toBe(0);
  });

  it("audits a real unlock against the admin who did it", async () => {
    for (let i = 0; i < MAX; i++) await login("WrongPassword1");
    const token = await loginAs(ADMIN);
    const id = await victimId();
    await unlock(token, id);

    const rows = await prisma.auditLog.findMany({ where: { action: "user.login_unlocked" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].record_id).toBe(id);
    expect(rows[0].user_id).not.toBe(id); // the ADMIN, not the unlocked user
  });

  it("404s for an unknown user", async () => {
    const token = await loginAs(ADMIN);
    expect((await unlock(token, "does-not-exist")).status).toBe(404);
  });

  // Unlock is an account-security action: it must not be reachable by the very
  // people a lockout is holding back.
  it("is admin-only", async () => {
    const id = await victimId();
    const victimToken = await loginAs(VICTIM);
    expect((await unlock(victimToken, id)).status).toBe(403);
  });
});
