/**
 * Test-only fixtures layered on top of the normal seed (prisma/seed.ts).
 *
 * A fresh database is missing exactly two things the integration + e2e suites
 * need, and neither is created by the main seed:
 *   1. The test REQUESTOR account (+60199990001). seed.ts creates the admin and
 *      drivers but never a requestor (real requestors self-register + get
 *      approved). Tests log in as this account to book trips.
 *   2. CONSIGNEES. The main seed imports them from an NDA Excel workbook that is
 *      gitignored and absent on a clean machine, so `seedConsignees()` skips and
 *      leaves ZERO consignees — every trip-seeding fixture then throws "No
 *      consignees available." We add a small synthetic set spread across the
 *      real zones (incl. A2, the PLX-2406-only zone dispatch fixtures rely on).
 *
 * Idempotent: the requestor upserts by phone; synthetic consignees are only
 * created when the table is empty, so a DB that already has the real Excel
 * consignees is left untouched (only the requestor is ensured).
 *
 * Run automatically by `npm run test:db:up`; standalone:
 *   npx tsx prisma/seed-test.ts   (with DATABASE_URL pointed at the test DB)
 */
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { assertNotProduction } from "./destructive-guard";

const BCRYPT_COST = 10;
const SEED_PASSWORD = "Password123"; // same placeholder as the main seed

export const TEST_REQUESTOR_PHONE = "+60199990001";

// Synthetic consignees, one or two per real zone. zone_code must reference a
// Zone row (seeded by seed.ts, which runs first). area/state are cosmetic.
const SYNTHETIC_CONSIGNEES: { company_name: string; zone_code: string; area: string; state: string }[] = [
  { company_name: "Test Consignee P1 Alpha", zone_code: "P1", area: "Penang Island", state: "Penang" },
  { company_name: "Test Consignee P2 Beta", zone_code: "P2", area: "Juru", state: "Penang" },
  { company_name: "Test Consignee P2 Gamma", zone_code: "P2", area: "Perai", state: "Penang" },
  { company_name: "Test Consignee P3 Delta", zone_code: "P3", area: "Tasek Gelugor", state: "Penang" },
  { company_name: "Test Consignee K1 Epsilon", zone_code: "K1", area: "Kulim", state: "Kedah" },
  { company_name: "Test Consignee K2 Zeta", zone_code: "K2", area: "Sungai Petani", state: "Kedah" },
  { company_name: "Test Consignee A1 Eta", zone_code: "A1", area: "Taiping", state: "Perak" },
  { company_name: "Test Consignee A2 Theta", zone_code: "A2", area: "Ipoh", state: "Perak" },
  { company_name: "Test Consignee KL Iota", zone_code: "KL", area: "Kuala Lumpur", state: "WP Kuala Lumpur" },
];

/** Ensure the test requestor account exists and is active. */
export async function ensureRequestor(client: PrismaClient = prisma): Promise<void> {
  const password_hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);
  await client.user.upsert({
    where: { phone: TEST_REQUESTOR_PHONE },
    update: {}, // existing account untouched — a changed password survives re-seed
    create: {
      phone: TEST_REQUESTOR_PHONE,
      password_hash,
      name: "Test Requestor",
      role: "requestor",
      status: "active",
    },
  });
  console.log(`Ensured test requestor (${TEST_REQUESTOR_PHONE} / ${SEED_PASSWORD}).`);
}

/**
 * Ensure at least the synthetic consignees exist — but ONLY when the table is
 * empty, so we never duplicate a real Excel import on a DB that already has it.
 */
export async function ensureConsignees(client: PrismaClient = prisma): Promise<void> {
  const existing = await client.consignee.count();
  if (existing > 0) {
    console.log(`Consignees already present (${existing} rows) — skipping synthetic seed.`);
    return;
  }
  for (const c of SYNTHETIC_CONSIGNEES) {
    await client.consignee.create({
      data: {
        company_name: c.company_name,
        zone_code: c.zone_code,
        area: c.area,
        state: c.state,
        vendor_code: `TEST-${c.zone_code}`,
        is_active: true,
      },
    });
  }
  console.log(`Seeded ${SYNTHETIC_CONSIGNEES.length} synthetic consignees (fresh test DB).`);
}

async function main() {
  // seed-test only ever CREATES fixtures (never deletes), so the soft guard is
  // enough: it refuses a known production host and allows any local/docker DB.
  assertNotProduction("seed-test");
  await ensureRequestor();
  await ensureConsignees();
}

// Only run the CLI when invoked directly; importing this module (from the
// test-DB reset helper / integration harness) must not execute the seed.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
