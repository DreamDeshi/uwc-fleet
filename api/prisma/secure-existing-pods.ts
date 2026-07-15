/**
 * BACKFILL: secure POD photos taken BEFORE the privacy fix.
 *
 * Legacy rows have a PUBLIC pod_photo (type "upload", enumerable by ticket) and
 * no pod_public_id. This script flips each existing `uwc/pod` asset to
 * `authenticated` (private delivery) on Cloudinary and records its public_id, so
 * the API serves it as a signed URL exactly like a new upload. New uploads are
 * already private — this only closes the hole for pre-fix photos.
 *
 * SAFE BY DEFAULT — DRY RUN. Prints what it would do and changes nothing.
 * Set APPLY=1 to actually rename the Cloudinary assets + backfill the rows.
 *
 * GUARDED like the credential CLIs (adminCredsCommon): a local DB target runs
 * freely; a PRODUCTION DATABASE_URL requires ALLOW_PROD_POD_MIGRATION=1. It
 * needs the same CLOUDINARY_* env the API uses (the assets live in that account).
 * Idempotent: rows already carrying a pod_public_id are skipped; an asset that
 * is already private just backfills the id. No premises photo data is printed.
 *
 * Run (from api/):
 *   npx tsx prisma/secure-existing-pods.ts                 # dry run
 *   APPLY=1 ALLOW_PROD_POD_MIGRATION=1 npx tsx prisma/secure-existing-pods.ts
 */
import { prisma } from "../src/lib/prisma";
import { cloudinary, isCloudinaryConfigured } from "../src/lib/cloudinary";
import { podPublicIdFromUrl } from "../src/lib/podPhotos";
import { loadApiEnv, resolveTarget, fail } from "./adminCredsCommon";

const SCRIPT = "secure-existing-pods";
const APPLY = process.env.APPLY === "1";

async function main() {
  loadApiEnv();
  resolveTarget(SCRIPT, "ALLOW_PROD_POD_MIGRATION");
  if (!isCloudinaryConfigured()) {
    fail(SCRIPT, "Cloudinary is not configured (CLOUDINARY_* env) — cannot migrate assets.");
  }

  const legacy = await prisma.tripStop.findMany({
    where: { pod_photo: { not: null }, pod_public_id: null },
    select: { id: true, pod_photo: true },
  });
  console.log(
    `▸ ${SCRIPT}: ${legacy.length} legacy POD photo(s) to secure${APPLY ? "" : "   (DRY RUN — set APPLY=1 to apply)"}.`
  );

  let secured = 0;
  let skipped = 0;
  let failed = 0;

  for (const stop of legacy) {
    const publicId = podPublicIdFromUrl(stop.pod_photo!);
    if (!publicId || !publicId.startsWith("uwc/pod/")) {
      console.warn(`  - skip stop ${stop.id}: unrecognized POD URL`);
      skipped++;
      continue;
    }
    if (!APPLY) {
      console.log(`  - would secure ${publicId}`);
      continue;
    }
    try {
      const renamed = await cloudinary.uploader.rename(publicId, publicId, {
        type: "upload",
        to_type: "authenticated",
        overwrite: true,
        invalidate: true,
      });
      await prisma.tripStop.update({
        where: { id: stop.id },
        data: { pod_public_id: publicId, pod_photo: renamed.secure_url },
      });
      secured++;
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      // A prior partial run may have already flipped it: the "upload"-type asset
      // is gone. Backfill the id so the API signs it; not a failure.
      if (/not found|resource not found/i.test(msg)) {
        await prisma.tripStop.update({ where: { id: stop.id }, data: { pod_public_id: publicId } });
        console.warn(`  - stop ${stop.id}: asset already private — backfilled id only.`);
        secured++;
      } else {
        console.error(`  - FAILED stop ${stop.id} (${publicId}): ${msg}`);
        failed++;
      }
    }
  }

  console.log(
    `\n✔ ${SCRIPT}: secured ${secured}, skipped ${skipped}, failed ${failed}${APPLY ? "." : "  (dry run — nothing changed)."}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
