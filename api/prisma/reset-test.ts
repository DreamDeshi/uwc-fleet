/**
 * Fast reset of the TEST database between runs: truncate every transactional
 * table (trips, stops, cargo, docs, location logs, audit, leave, fuel, etc.)
 * while KEEPING master data (users, trucks, zones, rates, holidays, consignees,
 * settings). Then re-ensure the test requestor + synthetic consignees.
 *
 * This is the same wipe the integration harness performs before each test, made
 * available as a CLI (`npm run test:db:reset`) for manual iteration — it does
 * NOT restart the container, so it is much faster than a full up/down cycle.
 *
 * DESTRUCTIVE: it TRUNCATEs. It therefore refuses to run against anything but a
 * localhost/docker DB, independent of the softer host-marker guard.
 */
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { ensureRequestor, ensureConsignees } from "./seed-test";

// Tables safe to wipe between tests. Master/reference tables are deliberately
// absent so a truncate never nukes seeded trucks, zones, rates or consignees.
// (No @@map in schema.prisma → Postgres table names are the PascalCase model
// names; they must stay double-quoted in SQL.)
export const TRANSACTIONAL_TABLES = [
  "TripStatusHistory",
  "LocationLog",
  "TripDocument",
  "CargoDetail",
  "ExternalForwarder",
  "TripStop",
  "Trip",
  "DriverLeave",
  "FuelLog",
  "VehicleMaintenance",
  "AuditLog",
] as const;

/**
 * Hard safety gate for a DESTRUCTIVE operation: only a local/docker Postgres is
 * ever acceptable. Throws otherwise (the caller decides whether to exit).
 */
export function assertLocalTestDb(url = process.env.DATABASE_URL): void {
  if (!url) throw new Error("DATABASE_URL is not set — refusing to truncate an unknown DB.");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`DATABASE_URL is not a parseable URL — refusing to truncate. Got: ${url}`);
  }
  const local = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
  const prodMarkers = ["rlwy.net", "railway.internal", "railway.app"];
  if (!local.includes(host) || prodMarkers.some((m) => host.includes(m))) {
    throw new Error(
      `Refusing to truncate a non-local database (host "${host}"). ` +
        `The test DB must be local (${local.join(", ")}).`
    );
  }
}

/** TRUNCATE all transactional tables in one statement (CASCADE handles FKs). */
export async function truncateTransactional(client: PrismaClient = prisma): Promise<void> {
  assertLocalTestDb();
  const list = TRANSACTIONAL_TABLES.map((t) => `"${t}"`).join(", ");
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

// Trucks are MASTER data (not truncated), but dispatch/guard tests legitimately
// mutate a truck's rates or document expiries. Restoring the fleet to spec
// defaults on every reset keeps those mutations from leaking between tests (and
// undoes any drift a prior run left behind). Expiries are set comfortably far
// in the future so every truck is roadworthy by default; a test that wants an
// expired doc sets it explicitly, and the next reset undoes it.
const FAR_FUTURE_EXPIRY = new Date("2030-01-01T00:00:00Z");

export async function restoreTruckDefaults(client: PrismaClient = prisma): Promise<void> {
  assertLocalTestDb();
  const specPath = path.resolve(__dirname, "../../docs/uwc-spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as {
    trucks: { plate: string; weekday_rate: number; offpeak_rate: number; daily_deduction: number }[];
  };
  for (const t of spec.trucks) {
    await client.truck.updateMany({
      where: { plate: t.plate },
      data: {
        entitled_claim_weekday: t.weekday_rate,
        entitled_claim_offpeak: t.offpeak_rate,
        daily_deduction_points: t.daily_deduction,
        pending_claim_weekday: null,
        pending_claim_offpeak: null,
        pending_deduction_points: null,
        pending_rates_effective: null,
        insurance_expiry: FAR_FUTURE_EXPIRY,
        permit_expiry: FAR_FUTURE_EXPIRY,
        road_tax_expiry: FAR_FUTURE_EXPIRY,
        is_available: true,
        retired_at: null, // undo any soft-retire a fleet-CRUD test performed
        operating_hours_start: "07:00",
        operating_hours_end: "18:00",
      },
    });
  }
}

async function main() {
  assertLocalTestDb();
  await truncateTransactional();
  await restoreTruckDefaults();
  await ensureRequestor();
  await ensureConsignees();
  console.log("✔ Test DB reset: transactional cleared, trucks restored, fixtures re-ensured.");
}

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
