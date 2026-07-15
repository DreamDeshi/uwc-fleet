/**
 * BACKFILL: secure trip DOCUMENTS (DO / invoice) uploaded BEFORE the privacy fix.
 *
 * Legacy TripDocument rows have a PUBLIC file_url (Cloudinary type "upload") and
 * no public_id. This flips each existing `uwc/documents` asset to `authenticated`
 * (private delivery) and records its public_id/resource_type/format so the API
 * serves it as a signed URL like a new upload. New uploads are already private —
 * this only closes the hole for pre-fix documents. Sibling of
 * secure-existing-pods.ts (documents have random ids, so they were not
 * enumerable, but were still public).
 *
 * SAFE BY DEFAULT — DRY RUN. `APPLY=1` to actually rename + backfill. Guarded:
 * a prod DATABASE_URL requires ALLOW_PROD_DOC_MIGRATION=1. Needs the CLOUDINARY_*
 * env. Idempotent: rows with a public_id are skipped; an already-private asset
 * just backfills the id. No document content is printed.
 *
 * Run (from api/):
 *   npx tsx prisma/secure-existing-documents.ts                  # dry run
 *   APPLY=1 ALLOW_PROD_DOC_MIGRATION=1 npx tsx prisma/secure-existing-documents.ts
 */
import { prisma } from "../src/lib/prisma";
import { cloudinary, isCloudinaryConfigured } from "../src/lib/cloudinary";
import { documentAssetFromUrl } from "../src/lib/podPhotos";
import { loadApiEnv, resolveTarget, fail } from "./adminCredsCommon";

const SCRIPT = "secure-existing-documents";
const APPLY = process.env.APPLY === "1";

async function main() {
  loadApiEnv();
  resolveTarget(SCRIPT, "ALLOW_PROD_DOC_MIGRATION");
  if (!isCloudinaryConfigured()) {
    fail(SCRIPT, "Cloudinary is not configured (CLOUDINARY_* env) — cannot migrate assets.");
  }

  const legacy = await prisma.tripDocument.findMany({
    where: { public_id: null },
    select: { id: true, file_url: true },
  });
  console.log(
    `▸ ${SCRIPT}: ${legacy.length} legacy document(s) to secure${APPLY ? "" : "   (DRY RUN — set APPLY=1 to apply)"}.`
  );

  let secured = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of legacy) {
    const asset = documentAssetFromUrl(doc.file_url);
    if (!asset || !asset.publicId.startsWith("uwc/documents/")) {
      console.warn(`  - skip document ${doc.id}: unrecognized URL`);
      skipped++;
      continue;
    }
    if (!APPLY) {
      console.log(`  - would secure ${asset.publicId} (${asset.resourceType})`);
      continue;
    }
    try {
      const renamed = await cloudinary.uploader.rename(asset.publicId, asset.publicId, {
        type: "upload",
        to_type: "authenticated",
        resource_type: asset.resourceType,
        overwrite: true,
        invalidate: true,
      });
      await prisma.tripDocument.update({
        where: { id: doc.id },
        data: {
          file_url: renamed.secure_url,
          public_id: asset.publicId,
          resource_type: asset.resourceType,
          format: asset.format ?? null,
        },
      });
      secured++;
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/not found|resource not found/i.test(msg)) {
        await prisma.tripDocument.update({
          where: { id: doc.id },
          data: { public_id: asset.publicId, resource_type: asset.resourceType, format: asset.format ?? null },
        });
        console.warn(`  - document ${doc.id}: asset already private — backfilled ids only.`);
        secured++;
      } else {
        console.error(`  - FAILED document ${doc.id} (${asset.publicId}): ${msg}`);
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
