/**
 * Clean reset — back to a blank operational slate.
 *
 * Wipes ALL trips (and their stops, cargo, documents, external forwarders and
 * GPS logs) and ALL test/registered user accounts, while keeping the base
 * reference data (trucks, zones, destination rates, departments, route types,
 * consignees) and the seeded login accounts.
 *
 * KEPT: the accounts the main seed creates — the bootstrap admin and the 6
 * fleet drivers (by phone) — plus every admin account (admins can't be
 * self-registered, so they're always intentional and never treated as test
 * data; this also guards against locking yourself out).
 *
 * DELETED: every other user. In practice that's all requestors and any other
 * self-registered accounts — so after a reset, UWC staff register fresh.
 *
 * Idempotent and safe to run anytime, including against prod: it only deletes
 * trips + non-seeded users, never base data, and clears each deleted user's
 * dependent rows first so foreign keys never block it. Re-running on an
 * already-clean DB is a no-op.
 *
 * Run with: npx tsx prisma/seed-clean.ts   (from the api/ workspace)
 */
import { prisma } from "../src/lib/prisma";

// Accounts created by seed.ts — never deleted. Keep in sync with seed.ts if the
// seeded admin/driver phone numbers ever change.
const SEEDED_PHONES = [
  "+60100000001", // bootstrap admin (UWC Admin)
  "+60100000101", // Driver 1      — PLX 2406
  "+60100000102", // Driver 2 — PND 1888
  "+60100000103", // Driver 3      — PRJ 5292
  "+60100000104", // Driver 4     — PQL 5292
  "+60100000105", // Driver 5 — PPE 1804
  "+60100000106", // Driver 6               — PRH 5292
];

async function main() {
  // ── 1. Wipe all trips + their children (FK order: children first) ───────
  const tripCount = await prisma.trip.count();
  await prisma.locationLog.deleteMany({});
  await prisma.tripDocument.deleteMany({});
  await prisma.externalForwarder.deleteMany({});
  await prisma.cargoDetail.deleteMany({});
  await prisma.tripStop.deleteMany({});
  const delTrips = await prisma.trip.deleteMany({});
  console.log(`Deleted ${delTrips.count} trip(s) and all their child records.`);

  // ── 2. Delete every non-seeded user ─────────────────────────────────────
  // Protect the seeded base accounts (by phone) and all admins.
  const keep = await prisma.user.findMany({
    where: { OR: [{ phone: { in: SEEDED_PHONES } }, { role: "admin" }] },
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
  const summary = {
    trips: await prisma.trip.count(),
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
  console.log(`\nClean state (started with ${tripCount} trips):`, summary);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
