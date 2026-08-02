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
import path from "path";
import { PrismaClient } from "@prisma/client";
import { assertTripWipeAllowed } from "./destructive-guard";
import { cloudinary, isCloudinaryConfigured } from "../src/lib/cloudinary";
import { podPublicIdFromUrl, documentAssetFromUrl } from "../src/lib/podPhotos";

const APPLY = process.argv.includes("--apply");

// Audit rows describing trip data. TripDocument is included deliberately: with
// it left out the "blank slate" still carried rows about paperwork whose trips
// no longer exist. Audit rows about Truck/User/AppSetting/etc. are NOT trip data
// and stay.
const TRIP_AUDIT_TABLES = ["Trip", "TripStop", "TripDocument"];

const prisma = new PrismaClient();

/** Every Cloudinary asset owned by trip data, with the ids needed to delete it. */
interface Asset {
  publicId: string;
  resourceType: string;
  source: string;
}

async function collectAssets(): Promise<Asset[]> {
  const assets: Asset[] = [];

  // POD + K2 both live on TripStop and are `type: "authenticated"` images.
  // ⚠ Legacy rows have a URL but no public_id (they predate the privacy work),
  // so fall back to parsing the id out of the stored URL — otherwise those
  // assets survive the wipe invisibly and keep costing storage.
  const stops = await prisma.tripStop.findMany({
    where: { OR: [{ pod_photo: { not: null } }, { k2_photo: { not: null } }] },
    select: { pod_public_id: true, pod_photo: true, k2_public_id: true, k2_photo: true },
  });
  for (const s of stops) {
    const pod = s.pod_public_id ?? (s.pod_photo ? podPublicIdFromUrl(s.pod_photo) : null);
    if (pod) assets.push({ publicId: pod, resourceType: "image", source: "TripStop.pod" });
    const k2 = s.k2_public_id ?? (s.k2_photo ? podPublicIdFromUrl(s.k2_photo) : null);
    if (k2) assets.push({ publicId: k2, resourceType: "image", source: "TripStop.k2" });
  }

  // Requestor paperwork. resource_type matters here — a PDF stored via
  // `resource_type: "auto"` can land as image OR raw, and deleting with the
  // wrong one silently no-ops.
  const docs = await prisma.tripDocument.findMany({
    select: { public_id: true, resource_type: true, file_url: true },
  });
  for (const d of docs) {
    if (d.public_id) {
      assets.push({
        publicId: d.public_id,
        resourceType: d.resource_type ?? "image",
        source: "TripDocument",
      });
    } else if (d.file_url) {
      const parsed = documentAssetFromUrl(d.file_url);
      if (parsed) {
        assets.push({
          publicId: parsed.publicId,
          resourceType: parsed.resourceType,
          source: "TripDocument(legacy-url)",
        });
      }
    }
  }

  // Exception evidence photos (flag is off today, so normally empty). Unlike
  // the others this model stores `public_id` NOT NULL and calls its URL `url`,
  // so there is no legacy-parse fallback to make.
  const evidence = await prisma.exceptionEvidence.findMany({ select: { public_id: true } });
  for (const e of evidence) {
    assets.push({ publicId: e.public_id, resourceType: "image", source: "ExceptionEvidence" });
  }

  return assets;
}

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
  const assets = await collectAssets();

  console.log("\n── WOULD DELETE (trip data) ──");
  console.table(before);
  console.log("── UNTOUCHED ──");
  console.table(keep);
  console.log(`── CLOUDINARY: ${assets.length} asset(s) owned by trip data ──`);
  for (const a of assets) console.log(`  ${a.source.padEnd(26)} ${a.resourceType.padEnd(6)} ${a.publicId}`);

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

  // Asset ids to disk BEFORE any delete, so a failed purge is retryable once
  // the rows that named them are gone.
  const manifest = path.resolve(__dirname, `../wipe-assets-${Date.now()}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ assets, counts: before }, null, 2));
  console.log(`\nAsset manifest written: ${manifest}`);

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
  if (assets.length === 0) {
    console.log("\nNo Cloudinary assets to purge.");
  } else if (!isCloudinaryConfigured()) {
    console.log(`\n⚠ Cloudinary not configured — ${assets.length} asset(s) NOT purged. Manifest: ${manifest}`);
  } else {
    let ok = 0;
    const failed: string[] = [];
    for (const a of assets) {
      try {
        // `type: "authenticated"` must match how they were uploaded, or the
        // delete silently reports "not found" and the asset survives.
        const res = await cloudinary.uploader.destroy(a.publicId, {
          resource_type: a.resourceType,
          type: "authenticated",
          invalidate: true,
        });
        if (res.result === "ok" || res.result === "not found") ok += 1;
        else failed.push(`${a.publicId} → ${res.result}`);
      } catch (e) {
        failed.push(`${a.publicId} → ${(e as Error).message}`);
      }
    }
    console.log(`\nCloudinary: ${ok}/${assets.length} purged.`);
    if (failed.length) {
      console.log("⚠ Failed (retry from the manifest):");
      for (const f of failed) console.log(`  ${f}`);
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
