/**
 * Shared harness for the integration suite: the supertest client bound to the
 * real Express app, the Prisma client (pointed at the Docker test DB by
 * setup.ts), and per-test DB reset + login helpers.
 *
 * IMPORTANT: setup.ts must have already set process.env.DATABASE_URL to the
 * local test DB before this module is imported (it runs as a vitest setupFile,
 * which executes before test modules). Importing `app` here loads the routes
 * and the Prisma singleton against that test URL.
 */
import supertest from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { truncateTransactional } from "../../prisma/reset-test";
import { ensureRequestor, ensureConsignees } from "../../prisma/seed-test";

export { prisma };

/** A fresh supertest client for the in-process app (no port bound). */
export const api = () => supertest(app);

/**
 * Reset to a known state between tests: wipe transactional tables (trips,
 * stops, cargo, leave, …) and re-ensure the test requestor + consignees. Master
 * data (trucks, zones, rates, holidays) is preserved, so this is fast.
 */
export async function resetDb(): Promise<void> {
  await truncateTransactional(prisma);
  await ensureRequestor(prisma);
  await ensureConsignees(prisma);
}

export interface Credentials {
  phone: string;
  password: string;
}

// Seeded accounts (see prisma/seed.ts + prisma/seed-test.ts).
export const ADMIN: Credentials = { phone: "+60100000001", password: "Password123" };
export const DRIVER: Credentials = { phone: "+60100000101", password: "Password123" }; // PLX 2406
export const REQUESTOR: Credentials = { phone: "+60199990001", password: "Password123" };

/** Log in and return the access token, throwing a readable error on failure. */
export async function loginAs(account: Credentials): Promise<string> {
  const res = await api().post("/api/v1/auth/login").send(account);
  if (res.status !== 200) {
    throw new Error(`login failed for ${account.phone}: ${res.status} ${res.text}`);
  }
  return res.body.accessToken as string;
}

/** Authorization header for a token. */
export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
