/**
 * Clean reset — back to a blank operational slate.
 *
 * Wipes ALL trips (and their stops, cargo, documents, external forwarders,
 * GPS logs and trip-related audit logs) and EVERY non-seeded user account,
 * while keeping the base reference data (trucks, zones, destination rates,
 * departments, route types, consignees).
 *
 * KEPT: a strict allowlist of exactly 8 seeded accounts (by phone) — the
 * bootstrap admin, the 6 fleet drivers, and the test requestor. Any account
 * whose phone is NOT on the allowlist is deleted, including stray admins or
 * requestors registered during testing. The allowlist includes the bootstrap
 * admin, so admin access is always preserved.
 *
 * DELETED: every other user — all test-registered requestors/drivers/admins —
 * so after a reset only the 8 seeded logins remain.
 *
 * ⚠ DESTRUCTIVE — NOT prod-safe. It permanently deletes every trip in the
 * target database (plus all non-allowlisted users and trip audit rows). It is
 * guarded (destructive-guard.ts): a production DATABASE_URL host is refused
 * outright, and any other target requires ALLOW_DESTRUCTIVE=1. Re-running on
 * an already-clean DB is a no-op, but idempotent ≠ harmless — never point it
 * at live data.
 *
 * Run with: ALLOW_DESTRUCTIVE=1 npx tsx prisma/seed-clean.ts
 *           (from the api/ workspace, non-prod DATABASE_URL only)
 */
import { prisma } from "../src/lib/prisma";
import { assertDestructiveAllowed } from "./destructive-guard";

// Allowlist: the ONLY user accounts kept. Every other user is deleted. Keep in
// sync with seed.ts if the seeded admin/driver/requestor phone numbers change.
const SEEDED_PHONES = [
  "+60100000001", // bootstrap admin (UWC Admin)
  "+60100000101", // PLX 2406 driver
  "+60100000102", // PND 1888 driver
  "+60100000103", // PRJ 5292 driver
  "+60100000104", // PQL 5292 driver
  "+60100000105", // PPE 1804 driver
  "+60100000106", // PRH 5292 driver
  "+60199990001", // test requestor
];

async function main() {
  // Refuses production outright; elsewhere requires ALLOW_DESTRUCTIVE=1.
  assertDestructiveAllowed("seed-clean");

  // ── 0. Before counts (so the wipe is visibly verifiable) ────────────────
  const before = {
    trips: await prisma.trip.count(),
    users: await prisma.user.count(),
  };
  console.log(`Before: ${before.trips} trip(s), ${before.users} user(s).`);

  // ── 1. Wipe all trips + their children (FK order: children first) ───────
  await prisma.locationLog.deleteMany({});
  await prisma.tripDocument.deleteMany({});
  await prisma.externalForwarder.deleteMany({});
  await prisma.cargoDetail.deleteMany({});
  // TripStatusHistory has a RESTRICT FK to Trip — clear it before the trips or
  // the trip delete is blocked.
  await prisma.tripStatusHistory.deleteMany({});
  await prisma.tripStop.deleteMany({});
  const delTrips = await prisma.trip.deleteMany({});
  // Trip-related audit-log rows (Trip / TripStop actions) — these reference no
  // Trip FK (record_id is a plain string) so they outlive the trip wipe; clear
  // them too for a truly blank slate. Audit logs about other tables are kept.
  const delTripAudits = await prisma.auditLog.deleteMany({
    where: { table_name: { in: ["Trip", "TripStop"] } },
  });
  console.log(
    `Deleted ${delTrips.count} trip(s) + all child records, and ${delTripAudits.count} trip-related audit-log row(s).`
  );

  // ── 2. Delete every user NOT on the seeded allowlist ─────────────────────
  // Strict allowlist: keep ONLY the 8 seeded phones; everything else goes.
  const keep = await prisma.user.findMany({
    where: { phone: { in: SEEDED_PHONES } },
    select: { id: true },
  });
  const keepIds = keep.map((u) => u.id);

  const toDelete = await prisma.user.findMany({
    where: { id: { notIn: keepIds } },
    select: { id: true, name: true, phone: true, role: true },
  });

  if (toDelete.length === 0) {
    console.log("No test users to remove — already clean.");
  } else {
    const delIds = toDelete.map((u) => u.id);

    // Clear dependents first so required FKs don't block the user delete, and
    // unlink (not delete) any consignees a removed user self-added — those stay
    // in the directory as base data.
    await prisma.auditLog.deleteMany({ where: { user_id: { in: delIds } } });
    await prisma.fuelLog.deleteMany({ where: { driver_id: { in: delIds } } });
    await prisma.consignee.updateMany({
      where: { created_by: { in: delIds } },
      data: { created_by: null },
    });

    const delUsers = await prisma.user.deleteMany({ where: { id: { in: delIds } } });
    console.log(`Deleted ${delUsers.count} test user(s):`);
    for (const u of toDelete) console.log(`  - ${u.name} (${u.role}, ${u.phone})`);
  }

  // ── 3. Confirm the clean state ───────────────────────────────────────────
  const remainingUsers = await prisma.user.count();
  const summary = {
    trips: await prisma.trip.count(),
    users: remainingUsers,
    admins: await prisma.user.count({ where: { role: "admin" } }),
    drivers: await prisma.user.count({ where: { role: "driver" } }),
    requestors: await prisma.user.count({ where: { role: "requestor" } }),
    trucks: await prisma.truck.count(),
    zones: await prisma.zone.count(),
    destinationRates: await prisma.destinationRate.count(),
    departments: await prisma.department.count(),
    routeTypes: await prisma.routeType.count(),
    consignees: await prisma.consignee.count(),
  };
  console.log(`\nClean state (before: ${before.trips} trips, ${before.users} users):`, summary);
  console.log(
    remainingUsers === SEEDED_PHONES.length
      ? `✓ Exactly the ${SEEDED_PHONES.length} seeded accounts remain.`
      : `⚠ Expected ${SEEDED_PHONES.length} seeded accounts but ${remainingUsers} remain — check the allowlist.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
