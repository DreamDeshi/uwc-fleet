/**
 * Cloudinary orphan reconciliation — folder census vs database references.
 *
 * Answers "what is in the account that nothing needs?" rather than "what am I
 * about to delete from the database?". See src/lib/assetReconcile.ts for why
 * that inversion is the whole point: the row-derived approach cannot see assets
 * stranded by an EARLIER wipe, so orphans accumulate silently and permanently.
 *
 * DRY RUN IS THE DEFAULT — it prints counts by folder and delivery type and
 * writes nothing.
 *
 * Run (dry run):
 *   DATABASE_URL=… npx tsx prisma/reconcile-assets.ts
 *   DATABASE_URL=… npx tsx prisma/reconcile-assets.ts --type=upload
 * Run (apply):
 *   ALLOW_ASSET_PURGE=1 EXPECT_ORPHANS=<n> DATABASE_URL=… \
 *     npx tsx prisma/reconcile-assets.ts --type=upload --apply
 *
 * `--type=upload` selects the PUBLIC assets only — the ones that predate the
 * authenticated-URL fix and are reachable without a signature. They are worth
 * being able to purge on their own, ahead of everything else.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { isCloudinaryConfigured } from "../src/lib/cloudinary";
import {
  listAllAssets,
  referencedPublicIds,
  findOrphans,
  implausibleScan,
  purgeAssets,
  type CloudAsset,
} from "../src/lib/assetReconcile";

const APPLY = process.argv.includes("--apply");
const typeArg = process.argv.find((a) => a.startsWith("--type="))?.split("=")[1];

const prisma = new PrismaClient();

function summarise(assets: CloudAsset[]) {
  const rows = new Map<string, { assets: number; mb: number; oldest: string; newest: string }>();
  for (const a of assets) {
    const key = `${a.type.padEnd(14)} ${a.resourceType.padEnd(6)} ${a.folder}`;
    const r = rows.get(key) ?? { assets: 0, mb: 0, oldest: a.createdAt, newest: a.createdAt };
    r.assets += 1;
    r.mb += a.bytes / 1024 / 1024;
    if (a.createdAt && a.createdAt < r.oldest) r.oldest = a.createdAt;
    if (a.createdAt && a.createdAt > r.newest) r.newest = a.createdAt;
    rows.set(key, r);
  }
  return [...rows.entries()]
    .sort()
    .map(([k, r]) => ({
      "type / kind / folder": k,
      assets: r.assets,
      MB: +r.mb.toFixed(2),
      from: r.oldest.slice(0, 10),
      to: r.newest.slice(0, 10),
    }));
}

async function main() {
  if (!isCloudinaryConfigured()) {
    console.error("✖ Cloudinary is not configured (CLOUDINARY_* env vars). Refusing to run.");
    process.exit(1);
  }

  const all = await listAllAssets();
  const scan = await referencedPublicIds(prisma);
  let orphans = findOrphans(all, scan);

  console.log(`\n── CLOUDINARY CENSUS — ${all.length} asset(s) under "uwc/" ──`);
  console.table(summarise(all));

  console.log("── DATABASE REFERENCES ──");
  console.log(`  distinct ids referenced: ${scan.ids.size}`);
  console.table([scan.rows]);
  if (Object.keys(scan.bySource).length) console.table([scan.bySource]);

  // ⚠ The safety net. An empty reference set is fine (a wiped DB produces one);
  // rows that SHOULD refer while nothing resolved is a broken parser, and
  // deleting on that basis would destroy live POD evidence.
  const broken = implausibleScan(scan);
  if (broken) {
    console.error(`\n✖ Reference scan looks broken: ${broken}`);
    console.error("  Refusing to classify anything as an orphan. Fix the scan first.\n");
    process.exit(1);
  }

  const referencedAssets = all.length - orphans.length;
  console.log(`── ORPHANS — ${orphans.length} of ${all.length} (${referencedAssets} still referenced) ──`);

  if (typeArg) {
    const before = orphans.length;
    orphans = orphans.filter((a) => a.type === typeArg);
    console.log(`  --type=${typeArg} → ${orphans.length} of those ${before}`);
  }
  if (orphans.length === 0) {
    console.log("\nNothing to purge.\n");
    return;
  }
  console.table(summarise(orphans));
  const totalMb = +(orphans.reduce((n, a) => n + a.bytes, 0) / 1024 / 1024).toFixed(2);
  console.log(`  TOTAL: ${orphans.length} asset(s), ${totalMb} MB`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing was deleted. Re-run with --apply and the locks.\n");
    return;
  }

  // ── Locks ──
  if (process.env.ALLOW_ASSET_PURGE !== "1") {
    console.error("\n✖ Refusing to delete without ALLOW_ASSET_PURGE=1.\n");
    process.exit(1);
  }
  const expected = Number(process.env.EXPECT_ORPHANS);
  if (!Number.isInteger(expected) || expected !== orphans.length) {
    console.error(
      `\n✖ EXPECT_ORPHANS=${process.env.EXPECT_ORPHANS ?? "(unset)"} but ${orphans.length} orphan(s) were found.` +
        "\n  Set it to the number you are authorising — this is what stops a stale" +
        "\n  authorisation deleting a set that has since changed.\n"
    );
    process.exit(1);
  }

  // Manifest BEFORE deleting: Cloudinary deletes are not recoverable, and this
  // is the only record of what was removed.
  // ⚠ NEVER inside the repo. A manifest written to the working tree gets picked
  // up by the next `git add` — set MANIFEST_DIR to keep one somewhere durable.
  const manifestDir = process.env.MANIFEST_DIR || os.tmpdir();
  const manifest = path.join(manifestDir, `purged-assets-${Date.now()}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ orphans, referencedIds: [...scan.ids] }, null, 2));
  console.log(`\nManifest written: ${manifest}`);

  const res = await purgeAssets(orphans);
  console.log(`\nPurged ${res.deleted}/${orphans.length}.`);
  if (res.failed.length) {
    console.log("⚠ Failed:");
    for (const f of res.failed.slice(0, 20)) console.log(`  ${f.publicId} → ${f.reason}`);
    if (res.failed.length > 20) console.log(`  … and ${res.failed.length - 20} more`);
  }

  const after = await listAllAssets();
  console.log(`\n── AFTER — ${after.length} asset(s) remain under "uwc/" ──`);
  if (after.length) console.table(summarise(after));
}

main()
  .catch((e) => {
    console.error("reconcile-assets failed:", String(e?.message ?? e).replace(/\w+:\/\/[^\s]+/g, "<redacted-url>"));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
