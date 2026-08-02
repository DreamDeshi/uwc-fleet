/**
 * SCOPED trip wipe — trip/booking/incentive data only, back to a blank
 * operational slate, with every account left exactly as it is.
 *
 * ── WHY THIS EXISTS RATHER THAN seed-clean.ts ───────────────────────────────
 * seed-clean.ts also deletes USER ACCOUNTS: everything outside an 8-phone
 * allowlist. Against the live database that list does not include the client's
 * own requestor login (TEH YUAN SHUANG) or the synthetic E2E driver, so running
 * it on prod would delete the customer's account. That is why its production
 * refusal has no override and must keep having none — do NOT point it here, and
 * do NOT give it this script's guard.
 *
 * This script cannot delete a user. There is no user delete in it at all.
 *
 * ── WHAT IT DELETES ─────────────────────────────────────────────────────────
 * Every Trip and all ten of its child tables, plus the audit rows describing
 * them. The child list was checked against the full schema (25 models): these
 * are exactly the models carrying a FK to Trip / TripStop / TripException.
 * Parents that merely hold back-relations (User, Truck, RouteType, Consignee)
 * are untouched.
 *
 * ── WHAT IT KEEPS ───────────────────────────────────────────────────────────
 * Consignees (all of them, including the three real extras), users of every
 * role, trucks, zones, destination rates, departments, route types, holidays,
 * driver leave, maintenance, app settings, fuel logs, cached route legs.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *  - DRY RUN IS THE DEFAULT. Nothing is written without --apply.
 *  - Three independent locks before any write (see assertTripWipeAllowed):
 *    ALLOW_TRIP_WIPE=1, CONFIRM_WIPE_HOST=<host> on prod, and EXPECT_TRIPS=<n>
 *    matching the live count.
 *  - Asset ids are written to a JSON file BEFORE anything is deleted, so a
 *    failed Cloudinary purge can be retried after the rows are gone.
 *  - The DB deletes run in ONE transaction with an explicit timeout — the
 *    Prisma default is 5s, which is not enough over the Railway public proxy.
 *
 * Run (dry run, safe, no locks needed):
 *   npx tsx prisma/wipe-trips.ts
 * Run (apply, production):
 *   ALLOW_TRIP_WIPE=1 CONFIRM_WIPE_HOST=<host> EXPECT_TRIPS=<n> \
 *     DATABASE_URL=<prod-url> npx tsx prisma/wipe-trips.ts --apply
 */
import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { assertTripWipeAllowed } from "./destructive-guard";
import { isCloudinaryConfigured } from "../src/lib/cloudinary";
import {
  listAllAssets,
  referencedPublicIds,
  findOrphans,
  implausibleScan,
  purgeAssets,
} from "../src/lib/assetReconcile";

const APPLY = process.argv.includes("--apply");

// Audit rows describing trip data. TripDocument is included deliberately: with
// it left out the "blank slate" still carried rows about paperwork whose trips
// no longer exist. Audit rows about Truck/User/AppSetting/etc. are NOT trip data
// and stay.
const TRIP_AUDIT_TABLES = ["Trip", "TripStop", "TripDocument"];

const prisma = new PrismaClient();

async function counts() {
  return {
    LocationLog: await prisma.locationLog.count(),
    TripDocument: await prisma.tripDocument.count(),
    ExternalForwarder: await prisma.externalForwarder.count(),
    CargoDetail: await prisma.cargoDetail.count(),
    TripStatusHistory: await prisma.tripStatusHistory.count(),
    TripChangeRequest: await prisma.tripChangeRequest.count(),
    ExceptionEvidence: await prisma.exceptionEvidence.count(),
    ExceptionAction: await prisma.exceptionAction.count(),
    TripException: await prisma.tripException.count(),
    TripStop: await prisma.tripStop.count(),
    Trip: await prisma.trip.count(),
    AuditLog_trip: await prisma.auditLog.count({
      where: { table_name: { in: TRIP_AUDIT_TABLES } },
    }),
  };
}

async function untouched() {
  return {
    User: await prisma.user.count(),
    Consignee: await prisma.consignee.count(),
    Truck: await prisma.truck.count(),
    Zone: await prisma.zone.count(),
    DestinationRate: await prisma.destinationRate.count(),
    Department: await prisma.department.count(),
    RouteType: await prisma.routeType.count(),
    PublicHoliday: await prisma.publicHoliday.count(),
    DriverLeave: await prisma.driverLeave.count(),
    VehicleMaintenance: await prisma.vehicleMaintenance.count(),
    AppSetting: await prisma.appSetting.count(),
    FuelLog: await prisma.fuelLog.count(),
    RouteLeg: await prisma.routeLeg.count(),
  };
}

async function main() {
  const before = await counts();
  const keep = await untouched();

  console.log("\n── WOULD DELETE (trip data) ──");
  console.table(before);
  console.log("── UNTOUCHED ──");
  console.table(keep);

  // ⚠ RECONCILIATION, NOT A ROW-DERIVED LIST. This used to collect asset ids off
  // the rows it was about to delete, which cannot see anything stranded by an
  // EARLIER wipe — so every run left its assets behind forever and the next run
  // was blind to them. By 2 Aug 2026 that had accumulated to 511 orphans against
  // an empty database, 145 of them publicly reachable. The census is the source
  // of truth about what exists; the DB about what is still needed.
  if (isCloudinaryConfigured()) {
    const census = await listAllAssets();
    const scanNow = await referencedPublicIds(prisma);
    console.log(
      `── CLOUDINARY: ${census.length} asset(s) under "uwc/", ${findOrphans(census, scanNow).length} already orphaned before this wipe ──`
    );
    console.log("   (the purge runs AFTER the delete and re-scans, so it also sweeps historical orphans)");
  } else {
    console.log("── CLOUDINARY: not configured — assets cannot be reconciled in this run ──");
  }

  // Users are counted and shown, never selected for deletion. Printing the
  // roster is the point: it is the check that this script is not seed-clean.
  const users = await prisma.user.groupBy({ by: ["role"], _count: { _all: true } });
  console.log("── USERS (NONE are deleted by this script) ──");
  console.table(users.map((u) => ({ role: u.role, count: u._count._all })));

  if (!APPLY) {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply and the required locks.\n");
    return;
  }

  // ── Locks. Only reached with --apply. ──
  assertTripWipeAllowed("wipe-trips", before.Trip);

  // ⚠ Written OUTSIDE the repo — a manifest dropped in the working tree gets
  // picked up by the next `git add`. Set MANIFEST_DIR to keep one somewhere
  // durable. This is the only record of what a run removed.
  const manifestDir = process.env.MANIFEST_DIR || os.tmpdir();
  const manifest = path.join(manifestDir, `wipe-assets-${Date.now()}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ counts: before }, null, 2));
  console.log(`\nManifest written: ${manifest}`);

  // ── DB deletes: children first, one transaction. ──
  // ⚠ Explicit timeout — Prisma's default is 5s and this runs over the Railway
  // public proxy, where that is not enough.
  const deleted = await prisma.$transaction(
    async (tx) => {
      const d: Record<string, number> = {};
      d.LocationLog = (await tx.locationLog.deleteMany({})).count;
      d.TripDocument = (await tx.tripDocument.deleteMany({})).count;
      d.ExternalForwarder = (await tx.externalForwarder.deleteMany({})).count;
      d.CargoDetail = (await tx.cargoDetail.deleteMany({})).count;
      // RESTRICT FKs to Trip — must go before the trips themselves.
      d.TripStatusHistory = (await tx.tripStatusHistory.deleteMany({})).count;
      d.TripChangeRequest = (await tx.tripChangeRequest.deleteMany({})).count;
      d.ExceptionEvidence = (await tx.exceptionEvidence.deleteMany({})).count;
      d.ExceptionAction = (await tx.exceptionAction.deleteMany({})).count;
      // Trip.open_exception_id points AT a TripException, so clear the pointer
      // before deleting the rows it references.
      await tx.trip.updateMany({ data: { open_exception_id: null } });
      d.TripException = (await tx.tripException.deleteMany({})).count;
      d.TripStop = (await tx.tripStop.deleteMany({})).count;
      d.Trip = (await tx.trip.deleteMany({})).count;
      d.AuditLog_trip = (
        await tx.auditLog.deleteMany({ where: { table_name: { in: TRIP_AUDIT_TABLES } } })
      ).count;
      return d;
    },
    { timeout: 120_000, maxWait: 30_000 }
  );

  console.log("\n── DELETED ──");
  console.table(deleted);

  // ── Cloudinary purge, AFTER the DB commit. ──
  // This order is deliberate: a failed purge leaves orphaned assets (a cost),
  // whereas purging first and then failing the DB delete would leave live rows
  // pointing at assets that no longer exist (broken evidence).
  if (!isCloudinaryConfigured()) {
    console.log("\n⚠ Cloudinary not configured — assets NOT purged. Run prisma/reconcile-assets.ts later.");
  } else {
    // Re-scan AFTER the commit: the assets belonging to the rows just deleted
    // are orphans only now, and the same pass sweeps anything stranded by an
    // earlier run.
    const census = await listAllAssets();
    const scanAfter = await referencedPublicIds(prisma);
    const broken = implausibleScan(scanAfter);
    if (broken) {
      // Never delete on a reference scan that looks defused — a missed
      // reference destroys live POD evidence, while a missed orphan costs only
      // storage.
      console.log(`\n⚠ Reference scan looks broken (${broken}) — NOT purging. Investigate, then run reconcile-assets.ts.`);
    } else {
      const orphans = findOrphans(census, scanAfter);
      fs.writeFileSync(manifest, JSON.stringify({ counts: before, orphans }, null, 2));
      const res = await purgeAssets(orphans);
      console.log(`\nCloudinary: ${res.deleted}/${orphans.length} orphan(s) purged (of ${census.length} total).`);
      if (res.failed.length) {
        console.log("⚠ Failed (retry from the manifest):");
        for (const f of res.failed.slice(0, 20)) console.log(`  ${f.publicId} → ${f.reason}`);
      }
    }
  }

  console.log("\n── AFTER ──");
  console.table(await counts());
  console.log("── STILL UNTOUCHED ──");
  console.table(await untouched());
}

main()
  .catch((e) => {
    // Never print a raw Prisma error: it stringifies DATABASE_URL, credentials
    // and all, into ordinary error messages.
    console.error("wipe-trips failed:", String(e?.message ?? e).replace(/\w+:\/\/[^\s]+/g, "<redacted-url>"));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
