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

async function main() {
  assertLocalTestDb();
  await truncateTransactional();
  await ensureRequestor();
  await ensureConsignees();
  console.log("✔ Test DB reset: transactional tables cleared, fixtures re-ensured.");
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
