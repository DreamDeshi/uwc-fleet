import { describe, it, expect, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";

/**
 * Self-service password reset request (owner-approved design, 20 Aug 2026).
 * Pure logic (TTL/expiry/CAS-where) is unit-tested without a DB in
 * tests/passwordResetRequests.test.ts. This is the "assert the guard is
 * REACHED" half: the real routes, against a real database — including
 * proving the LOGIN route actually calls the auto-close (AGENTS.md: "assert
 * the login route CALLS it, proven by deleting the call site").
 *
 * Runs on a dedicated throwaway account, same reasoning as loginLockout.test.ts:
 * the seeded logins are shared by every other file in the suite.
 */

const VICTIM = { phone: "+60188880010", password: "ResetRequestTester123" };

async function ensureVictim() {
  const password_hash = await bcrypt.hash(VICTIM.password, 10);
  await prisma.user.upsert({
    where: { phone: VICTIM.phone },
    update: {
      password_hash,
      name: "Reset Request Tester",
      role: "driver",
      status: "active",
      employee_number: "T-010",
      failed_login_attempts: 0,
      locked_until: null,
      last_login_at: null,
    },
    create: {
      phone: VICTIM.phone,
      password_hash,
      name: "Reset Request Tester",
      role: "driver",
      status: "active",
      employee_number: "T-010",
    },
  });
  return prisma.user.findUniqueOrThrow({ where: { phone: VICTIM.phone } });
}

const createRequest = (phone: string, new_password: string) =>
  api().post("/api/v1/auth/password-reset-requests").send({ phone, new_password });

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /auth/password-reset-requests (public, unauthenticated)", () => {
  it("creates a request for a real phone, storing a hash of the NEW password (never the plaintext)", async () => {
    const victim = await ensureVictim();
    const res = await createRequest(VICTIM.phone, "BrandNewPassword123");
    expect(res.status).toBe(200);

    const rows = await prisma.passwordResetRequest.findMany({ where: { user_id: victim.id } });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].new_password_hash).not.toContain("BrandNewPassword123");
    expect(await bcrypt.compare("BrandNewPassword123", rows[0].new_password_hash)).toBe(true);
  });

  it("NON-ENUMERATION: an unknown phone gets the identical 200 + body, and creates no row", async () => {
    const known = await ensureVictim();
    const [knownRes, unknownRes] = await Promise.all([
      createRequest(VICTIM.phone, "BrandNewPassword123"),
      createRequest("+60188889999", "BrandNewPassword123"),
    ]);
    expect(unknownRes.status).toBe(knownRes.status);
    expect(unknownRes.body).toEqual(knownRes.body);

    const rows = await prisma.passwordResetRequest.findMany();
    expect(rows.length).toBe(1); // only the known user's
    expect(rows[0].user_id).toBe(known.id);
  });

  it("ONE OPEN REQUEST PER USER: a second request while one is pending does not create a duplicate, and returns the identical response", async () => {
    await ensureVictim();
    const first = await createRequest(VICTIM.phone, "FirstPassword123");
    const second = await createRequest(VICTIM.phone, "SecondPassword123");
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);

    const rows = await prisma.passwordResetRequest.findMany();
    expect(rows.length).toBe(1);
    // The FIRST request's hash stands — a flood of requests cannot let someone
    // silently overwrite what an earlier request will promote.
    expect(await bcrypt.compare("FirstPassword123", rows[0].new_password_hash)).toBe(true);
  });

  it("rejects a weak new_password with the same strength floor as everywhere else", async () => {
    await ensureVictim();
    const res = await createRequest(VICTIM.phone, "weak");
    expect(res.status).toBe(400);
    expect(await prisma.passwordResetRequest.count()).toBe(0);
  });
});

describe("GET /password-reset-requests (admin queue)", () => {
  it("lists a pending request with the fields the design specifies (name, employee number, truck, lockout, last login)", async () => {
    // setup.ts sets LOGIN_LOCKOUT_MAX_ATTEMPTS=0 for the whole suite (so the
    // ~150 other tests' wrong-password paths never trip a lock) — override it
    // here, same pattern as tests-integration/loginLockout.test.ts, or
    // is_locked reads false regardless of the victim's own locked_until.
    const ORIGINAL_MAX = process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS;
    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "3";
    try {
      const victim = await ensureVictim();
      await prisma.user.update({
        where: { id: victim.id },
        data: { failed_login_attempts: 10, locked_until: new Date(Date.now() + 60_000) },
      });
      await createRequest(VICTIM.phone, "BrandNewPassword123");

      const admin = await loginAs(ADMIN);
      const res = await api().get("/api/v1/password-reset-requests").set(auth(admin));
      expect(res.status).toBe(200);
      const row = res.body.find((r: { user: { id: string } }) => r.user.id === victim.id);
      expect(row).toBeTruthy();
      expect(row.status).toBe("pending");
      expect(row.user.name).toBe("Reset Request Tester");
      expect(row.user.employee_number).toBe("T-010");
      expect(row.user.is_locked).toBe(true);
      expect(row.user.last_login_at).toBeNull();
    } finally {
      if (ORIGINAL_MAX === undefined) delete process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS;
      else process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = ORIGINAL_MAX;
    }
  });

  it("a non-admin cannot reach the queue", async () => {
    const requestor = await loginAs(REQUESTOR);
    const res = await api().get("/api/v1/password-reset-requests").set(auth(requestor));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /password-reset-requests/:id/approve", () => {
  it("promotes the chosen password, revokes the session, and CLEARS the lockout", async () => {
    const victim = await ensureVictim();
    await prisma.user.update({
      where: { id: victim.id },
      data: {
        failed_login_attempts: 10,
        locked_until: new Date(Date.now() + 60_000),
        refresh_token_hash: "some-stale-hash",
      },
    });
    await createRequest(VICTIM.phone, "BrandNewPassword123");
    const request = await prisma.passwordResetRequest.findFirstOrThrow({ where: { user_id: victim.id } });

    const admin = await loginAs(ADMIN);
    const res = await api()
      .patch(`/api/v1/password-reset-requests/${request.id}/approve`)
      .set(auth(admin));
    expect(res.status).toBe(200);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(await bcrypt.compare("BrandNewPassword123", updated.password_hash)).toBe(true);
    expect(updated.refresh_token_hash).toBeNull();
    expect(updated.failed_login_attempts).toBe(0);
    expect(updated.locked_until).toBeNull();

    const resolvedRequest = await prisma.passwordResetRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(resolvedRequest.status).toBe("approved");
    expect(resolvedRequest.resolved_by).not.toBeNull();

    // The new password actually logs in.
    const loginRes = await api()
      .post("/api/v1/auth/login")
      .send({ phone: VICTIM.phone, password: "BrandNewPassword123" });
    expect(loginRes.status).toBe(200);
  });

  it("a second approve attempt on the SAME request fails (CAS) and touches nothing", async () => {
    const victim = await ensureVictim();
    await createRequest(VICTIM.phone, "BrandNewPassword123");
    const request = await prisma.passwordResetRequest.findFirstOrThrow({ where: { user_id: victim.id } });
    const admin = await loginAs(ADMIN);

    const first = await api().patch(`/api/v1/password-reset-requests/${request.id}/approve`).set(auth(admin));
    expect(first.status).toBe(200);
    const second = await api().patch(`/api/v1/password-reset-requests/${request.id}/approve`).set(auth(admin));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("REQUEST_NOT_APPROVABLE");
  });

  it("an EXPIRED (24h+) request cannot be approved", async () => {
    const victim = await ensureVictim();
    await createRequest(VICTIM.phone, "BrandNewPassword123");
    const request = await prisma.passwordResetRequest.findFirstOrThrow({ where: { user_id: victim.id } });
    await prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: { requested_at: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const admin = await loginAs(ADMIN);
    const listRes = await api().get("/api/v1/password-reset-requests?status=all").set(auth(admin));
    const row = listRes.body.find((r: { id: string }) => r.id === request.id);
    expect(row.status).toBe("expired");

    const approveRes = await api().patch(`/api/v1/password-reset-requests/${request.id}/approve`).set(auth(admin));
    expect(approveRes.status).toBe(409);

    // Untouched: the account's password never changed.
    const stillOld = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(await bcrypt.compare(VICTIM.password, stillOld.password_hash)).toBe(true);
  });
});

describe("PATCH /password-reset-requests/:id/dismiss", () => {
  it("closes the request without touching the account", async () => {
    const victim = await ensureVictim();
    await createRequest(VICTIM.phone, "BrandNewPassword123");
    const request = await prisma.passwordResetRequest.findFirstOrThrow({ where: { user_id: victim.id } });
    const admin = await loginAs(ADMIN);

    const res = await api().patch(`/api/v1/password-reset-requests/${request.id}/dismiss`).set(auth(admin));
    expect(res.status).toBe(200);

    const resolved = await prisma.passwordResetRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(resolved.status).toBe("dismissed");
    expect(resolved.resolved_by).not.toBeNull();

    const stillOld = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(await bcrypt.compare(VICTIM.password, stillOld.password_hash)).toBe(true);
  });
});

describe("login AUTO-CLOSES a pending request (the real event, R6)", () => {
  it("a successful login with the OLD password dismisses any pending request, with no admin actor", async () => {
    const victim = await ensureVictim();
    await createRequest(VICTIM.phone, "BrandNewPassword123");
    const request = await prisma.passwordResetRequest.findFirstOrThrow({ where: { user_id: victim.id } });
    expect(request.status).toBe("pending");

    // The driver remembered their OLD password before the office acted.
    const loginRes = await api()
      .post("/api/v1/auth/login")
      .send({ phone: VICTIM.phone, password: VICTIM.password });
    expect(loginRes.status).toBe(200);

    const resolved = await prisma.passwordResetRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(resolved.status).toBe("dismissed");
    expect(resolved.resolved_by).toBeNull(); // the SYSTEM closed it, not an admin

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(updatedUser.last_login_at).not.toBeNull();
  });

  it("does not touch a DIFFERENT user's pending request", async () => {
    const victim = await ensureVictim();
    await createRequest(VICTIM.phone, "BrandNewPassword123");
    const request = await prisma.passwordResetRequest.findFirstOrThrow({ where: { user_id: victim.id } });

    const requestor = await loginAs(REQUESTOR); // an unrelated account logging in
    expect(requestor).toBeTruthy();

    const untouched = await prisma.passwordResetRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(untouched.status).toBe("pending");
  });
});
