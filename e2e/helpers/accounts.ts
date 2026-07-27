/**
 * Deployment targets and the pre-seeded test accounts.
 *
 * TARGETS ARE ENV-DRIVEN — the suite no longer points at production by
 * default. The e2e reset is destructive (cancels ALL pending/approved trips,
 * drives the test driver's active trips to completion with a stub POD, and
 * one spec edits a truck's rates), so hitting the live deployment must be a
 * conscious choice:
 *
 *   - Default: local dev servers (start api/mobile yourself).
 *   - E2E_ALLOW_PROD=1        → targets the deployed Railway apps (the old
 *     behaviour, used for post-deploy verification) with a loud warning.
 *   - E2E_API_URL / E2E_MOBILE_URL → explicit per-service overrides (e.g. a
 *     staging deployment); a Railway host still requires E2E_ALLOW_PROD=1.
 *   - E2E_PASSWORD            → password for ALL three accounts (defaults to the
 *     local fresh-seed placeholder). Use after the credentials are rotated.
 *   - E2E_ADMIN_PASSWORD / E2E_DRIVER_PASSWORD / E2E_REQUESTOR_PASSWORD →
 *     per-account overrides (each falls back to E2E_PASSWORD). Needed once the
 *     accounts have DISTINCT rotated passwords (the normal post-rotation state).
 *   - E2E_DRIVER_PHONE → which driver account the suite logs in as. Optional
 *     locally (defaults to the seeded test driver). REQUIRED against prod,
 *     and must NOT be a real employee's seeded phone — see the guard below.
 *
 * The accounts already exist wherever the seeds ran (see api/prisma/seed.ts /
 * seed-clean.ts). Tests never create users — they log in as these and drive
 * trip state via the API (see helpers/api.ts) so each spec can seed its own
 * fixtures.
 */

const PROD_MOBILE_URL = "https://uwc-mobile-production.up.railway.app";
const PROD_API_URL = "https://uwc-api-production.up.railway.app";

const LOCAL_MOBILE_URL = "http://localhost:8081"; // expo web dev server
const LOCAL_API_URL = "http://localhost:3000"; // api dev server

const ALLOW_PROD = process.env.E2E_ALLOW_PROD === "1";

export const MOBILE_URL =
  process.env.E2E_MOBILE_URL ?? (ALLOW_PROD ? PROD_MOBILE_URL : LOCAL_MOBILE_URL);
export const API_URL = process.env.E2E_API_URL ?? (ALLOW_PROD ? PROD_API_URL : LOCAL_API_URL);
export const API_BASE = `${API_URL}/api/v1`;

// Any Railway host counts as production for the opt-in check.
const isProdUrl = (url: string) => /railway\.app|rlwy\.net/i.test(new URL(url).hostname);
const prodTargets = [API_URL, MOBILE_URL].filter(isProdUrl);

if (prodTargets.length > 0 && !ALLOW_PROD) {
  throw new Error(
    [
      "e2e: refusing to run against PRODUCTION targets without an explicit opt-in:",
      ...prodTargets.map((u) => `  - ${u}`),
      "This suite CREATES AND MODIFIES REAL DATA: the per-spec reset cancels every",
      "pending/approved trip, completes the test driver's active trips with a stub",
      "POD photo, and the rate-reset spec edits a real truck's rates.",
      "Set E2E_ALLOW_PROD=1 to consciously run against production, or point",
      "E2E_API_URL / E2E_MOBILE_URL at non-prod targets.",
    ].join("\n")
  );
}

if (prodTargets.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    [
      "",
      "⚠⚠⚠  e2e: E2E_ALLOW_PROD=1 — RUNNING AGAINST THE LIVE PRODUCTION DEPLOYMENT.",
      "     Real pending/approved trips WILL be cancelled, the test driver's active",
      "     trips WILL be completed with a stub POD, and truck rates WILL be edited.",
      "     Do not run this while the client trial has live work in flight.",
      "",
    ].join("\n")
  );
}

// ── Real-employee protection (27 Jul 2026) ──────────────────────────────
// On the DEPLOYED database the seeded driver phones +60100000101…106 belong
// to REAL employees (the identity overlay gives those rows their real names,
// and the drivers use them for the live trial). A prod e2e run once drove
// the +60100000101 account — a real driver — and left 8 test trips in his
// incentive-approval queue. Rule: against ANY prod target the driver account
// must be chosen EXPLICITLY via E2E_DRIVER_PHONE, and it can never be one of
// the real seeded phones. The dedicated prod test driver is TRUCKLESS by
// design, so driver-flow suites cannot run against prod at all — destructive
// driver suites belong on the local Docker stack (npm run test:db:up).
const REAL_SEEDED_DRIVER_PHONES = [
  "+60100000101",
  "+60100000102",
  "+60100000103",
  "+60100000104",
  "+60100000105",
  "+60100000106",
];
const DRIVER_PHONE_ENV = process.env.E2E_DRIVER_PHONE?.trim();

if (prodTargets.length > 0) {
  if (!DRIVER_PHONE_ENV) {
    throw new Error(
      [
        "e2e: refusing to run against PRODUCTION without an explicit E2E_DRIVER_PHONE.",
        "The default driver account (+60100000101) is a REAL employee on prod.",
        "Set E2E_DRIVER_PHONE to the dedicated prod test driver (truckless), and",
        "run driver-flow suites only on the local Docker stack.",
      ].join("\n")
    );
  }
  if (REAL_SEEDED_DRIVER_PHONES.includes(DRIVER_PHONE_ENV)) {
    throw new Error(
      [
        `e2e: E2E_DRIVER_PHONE=${DRIVER_PHONE_ENV} is a REAL employee's account on prod.`,
        "Prod runs may only use the dedicated test driver. Real seeded driver",
        "phones (+60100000101…106) are always refused against production targets.",
      ].join("\n")
    );
  }
}

export interface Account {
  phone: string;
  password: string;
}

// Account passwords. A LOCAL fresh seed still creates the placeholder default,
// so that remains the ultimate fallback for local runs. Against any deployment
// with rotated, per-account passwords, set the per-role vars (or a single
// E2E_PASSWORD if they still share one). Precedence: per-role → E2E_PASSWORD →
// local seed placeholder.
const SEED_PLACEHOLDER = "Password123";
const sharedPassword = process.env.E2E_PASSWORD ?? SEED_PLACEHOLDER;

export const ADMIN: Account = {
  phone: "+60100000001",
  password: process.env.E2E_ADMIN_PASSWORD ?? sharedPassword,
};
export const DRIVER: Account = {
  // Local default: the seeded PLX 2406 test driver. Against prod the guard
  // above has already required E2E_DRIVER_PHONE and vetoed real employees.
  phone: DRIVER_PHONE_ENV ?? "+60100000101",
  password: process.env.E2E_DRIVER_PASSWORD ?? sharedPassword,
};
export const REQUESTOR: Account = {
  phone: "+60199990001",
  password: process.env.E2E_REQUESTOR_PASSWORD ?? sharedPassword,
};

// the PLX 2406 driver's assigned truck. The /approve endpoint requires truck_plate to match the
// driver's assigned_truck_plate; helpers/api.ts resolves this live from
// GET /users/me, but this is the expected value for reference.
export const DRIVER_TRUCK_PLATE = "PLX 2406";
