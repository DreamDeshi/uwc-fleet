/**
 * Deployed targets and the pre-seeded Railway test accounts.
 *
 * These accounts already exist in the Railway DB (see api/prisma/seed-clean.ts).
 * Tests never create users — they log in as these and drive trip state via the
 * API (see helpers/api.ts) so each spec can seed its own fixtures.
 */

export const MOBILE_URL = "https://uwc-mobile-production.up.railway.app";
export const ADMIN_URL = "https://uwc-admin-production.up.railway.app";
export const API_URL = "https://uwc-api-production.up.railway.app";
export const API_BASE = `${API_URL}/api/v1`;

export interface Account {
  phone: string;
  password: string;
}

export const ADMIN: Account = { phone: "+60100000001", password: "Password123" };
export const DRIVER: Account = { phone: "+60100000101", password: "Password123" }; // the PLX 2406 driver
export const REQUESTOR: Account = { phone: "+60199990001", password: "Password123" };

// the PLX 2406 driver's assigned truck. The /approve endpoint requires truck_plate to match the
// driver's assigned_truck_plate; helpers/api.ts resolves this live from
// GET /users/me, but this is the expected value for reference.
export const DRIVER_TRUCK_PLATE = "PLX 2406";

// localStorage keys the admin SPA reads its session from (admin/src/services/api.ts).
// Seeding these lets admin specs skip the login UI on every test.
export const ADMIN_TOKEN_KEY = "uwc.admin.accessToken";
export const ADMIN_REFRESH_KEY = "uwc.admin.refreshToken";
