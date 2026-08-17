/**
 * DOWNGRADE the duplicate-pin demotions instead of leaving them positionless.
 *
 * The backstop in geocode-google.ts deletes a BUILDING-grade coordinate that is
 * shared with a different address, because a shared "rooftop" is the geocoder
 * giving up. Deleting was the only option before precision was a value, and it
 * is expensive: measured on the 222 affected production rows, the zone centroid
 * they fall back to is a MEDIAN OF 7.3 KM away — 70% over 5 km, worst 46 km.
 *
 * This restores the pin where the cluster is PROVABLY one place, at ROAD grade:
 *
 *   SHARED_PIN            same address, or the same street. Coordinates
 *                         restored. Drivable; never judgeable (lib/earlyTap
 *                         asks isJudgeablePin, and road grade fails it).
 *   SHARED_PIN_AMBIGUOUS  different streets, or an address that cannot be
 *                         parsed at all. Coordinates stay NULL, exactly as
 *                         today — but the row now SAYS SO, so a later bulk fix
 *                         finds the reason instead of one uniform-looking set.
 *
 * ⚠ THE DUMP'S ROW IDS ARE NOT PRODUCTION'S. The consignee rows were
 * re-created after that dump was taken (a wipe and re-import), so every id in
 * it is stale: a lookup by id matches ZERO rows. The first run of this script
 * did exactly that, wrote nothing, and reported "skipped (already had a
 * position): 222" — a confident, benign-sounding summary of having done
 * nothing at all. It was caught by reading the database instead of the report.
 *
 * So the join is on (company_name + address_1), which was verified against
 * production before use: 1561 of 1561 dump rows match exactly one live row,
 * with no ambiguous and no missing, and all 222 demoted rows match. A row that
 * does not match UNIQUELY is skipped and counted, never guessed at.
 *
 * ⚠ WHERE THE COORDINATES COME FROM. They were discarded at write time, so they
 * are not in the database. They are in the geocoder's own --out dump, which is
 * why that dump is kept (see the "geocode MUST use --out" note). Pass it with
 * --dump. The script NEVER geocodes: no API key, no network, no quota.
 *
 * ⚠ REVERSAL. Every row this touches ends with geocode_match_type SHARED_PIN or
 * SHARED_PIN_AMBIGUOUS, so the affected set is exactly recoverable by that
 * value. The dump carries each row's ORIGINAL verdict, so the pre-change state
 * is fully reconstructable: set latitude/longitude NULL and restore the
 * verdict. `--revert` does exactly that.
 *
 *   npx tsx scripts/downgrade-shared-pins.ts --dump <file>            # dry run
 *   npx tsx scripts/downgrade-shared-pins.ts --dump <file> --apply
 *   npx tsx scripts/downgrade-shared-pins.ts --dump <file> --revert --apply
 *
 * Guarded to a LOCAL database unless ALLOW_REMOTE_DB=1, like the geocoder.
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { dbHostOf, isLocalDbHost, isProdDbHost } from "../src/lib/dbGuard";
import { classifyCluster, keepsPin, type ClusterVerdict } from "../src/lib/sharedPinCluster";

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const DUMP = (() => {
  const i = process.argv.indexOf("--dump");
  return i > -1 ? process.argv[i + 1] : "";
})();

const BUILDING = ["ROOFTOP", "RANGE_INTERPOLATED"];
const norm = (s: string | null) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

type DumpRow = {
  id: string;
  name: string | null;
  address_1: string | null;
  lat: number | null;
  lng: number | null;
  location_type: string;
};

/**
 * IDENTITY FIRST, and it EXITS on a mismatch rather than leaving the reader to
 * notice. Production carries nine REAL plates and a four-figure consignee
 * count; the demo is deliberately re-plated UWC 1001–1009.
 */
async function assertIdentity(): Promise<void> {
  const host = dbHostOf(process.env.DATABASE_URL) ?? "(unknown)";
  const remoteOk = process.env.ALLOW_REMOTE_DB === "1";
  if ((!isLocalDbHost(host) || isProdDbHost(host)) && !remoteOk) {
    throw new Error(`Refusing to touch non-local database host "${host}". Set ALLOW_REMOTE_DB=1.`);
  }
  const plates = (await prisma.truck.findMany({ select: { plate: true } })).map((t) => t.plate);
  const consignees = await prisma.consignee.count();
  console.log(`DB host      : ${host}${remoteOk ? "  (ALLOW_REMOTE_DB=1)" : "  (local)"}`);
  console.log(`Identity     : ${plates.length} plates, ${consignees} consignees`);
  if (plates.length === 0) throw new Error("REFUSING: no trucks — not a seeded instance.");
  if (plates.some((p) => /^UWC 10\d\d$/.test(p))) {
    throw new Error("REFUSING: synthetic UWC 10xx plates — this is the DEMO, not production.");
  }
  if (consignees < 1000) {
    throw new Error(`REFUSING: ${consignees} consignees is not production's four-figure count.`);
  }
  console.log("Identity OK  : PRODUCTION\n");
}

/** Rebuild the demoted clusters from the dump, exactly as the backstop did. */
function demotedClusters(rows: DumpRow[]) {
  const byCoord = new Map<string, DumpRow[]>();
  for (const r of rows) {
    if (r.lat == null || r.lng == null || !BUILDING.includes(r.location_type)) continue;
    const k = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
    if (!byCoord.has(k)) byCoord.set(k, []);
    byCoord.get(k)!.push(r);
  }
  return [...byCoord.entries()]
    .map(([coord, members]) => ({ coord, members }))
    .filter((c) => c.members.length > 1 && new Set(c.members.map((m) => norm(m.address_1))).size > 1);
}

async function main() {
  if (!DUMP) throw new Error("--dump <file> is required (the geocoder's --out dump).");
  await assertIdentity();

  const rows: DumpRow[] = JSON.parse(readFileSync(DUMP, "utf8"));
  const clusters = demotedClusters(rows);
  console.log(`Dump         : ${rows.length} rows → ${clusters.length} demoted clusters`);

  // Join the dump to the LIVE table by name+address; ids are stale (above).
  const live = await prisma.consignee.findMany({
    select: { id: true, company_name: true, address_1: true },
  });
  const liveByKey = new Map<string, { id: string }[]>();
  for (const r of live) {
    const k = `${norm(r.company_name)}|${norm(r.address_1)}`;
    if (!liveByKey.has(k)) liveByKey.set(k, []);
    liveByKey.get(k)!.push(r);
  }

  const plan: { id: string; verdict: ClusterVerdict; lat: number; lng: number; was: string }[] = [];
  let unmatched = 0;
  let ambiguousMatch = 0;
  for (const c of clusters) {
    const verdict = classifyCluster(c.members.map((m) => m.address_1));
    for (const m of c.members) {
      const hits = liveByKey.get(`${norm(m.name)}|${norm(m.address_1)}`) ?? [];
      if (hits.length === 0) { unmatched++; continue; }
      if (hits.length > 1) { ambiguousMatch++; continue; }
      plan.push({ id: hits[0].id, verdict, lat: m.lat!, lng: m.lng!, was: m.location_type });
    }
  }
  if (unmatched || ambiguousMatch) {
    console.log(`
⚠ JOIN GAPS — these rows are NOT in the plan:`);
    console.log(`  no live row for the dump entry : ${unmatched}`);
    console.log(`  more than one live row matched : ${ambiguousMatch}`);
  }
  const keep = plan.filter((p) => keepsPin(p.verdict));
  const ambiguous = plan.filter((p) => !keepsPin(p.verdict));

  console.log(`\n=== PLAN ===`);
  console.log(`  SHARED_PIN            (pin restored, ROAD grade) : ${keep.length}`);
  console.log(`  SHARED_PIN_AMBIGUOUS  (stays positionless)       : ${ambiguous.length}`);
  const byVerdict: Record<string, number> = {};
  for (const p of plan) byVerdict[p.verdict] = (byVerdict[p.verdict] ?? 0) + 1;
  console.log(`  by verdict: ${JSON.stringify(byVerdict)}`);

  // ── Sample, so a human can see WHAT would change before it changes ────────
  console.log(`\n=== SAMPLE (8 of ${keep.length} restorations) ===`);
  for (const p of keep.slice(0, 8)) {
    console.log(`  ${p.id}  ${p.was.padEnd(19)} → SHARED_PIN   ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
  }
  console.log(`\n=== SAMPLE (5 of ${ambiguous.length} left positionless) ===`);
  for (const p of ambiguous.slice(0, 5)) {
    console.log(`  ${p.id}  ${p.was.padEnd(19)} → SHARED_PIN_AMBIGUOUS  (no coordinates)`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to write.`);
    return;
  }

  if (REVERT) {
    // Put every touched row back: no coordinates, original verdict from the
    // dump. Keyed on the verdicts this script writes, so it can only ever undo
    // its own work.
    let reverted = 0;
    for (const p of plan) {
      const n = await prisma.consignee.updateMany({
        where: { id: p.id, geocode_match_type: { in: ["SHARED_PIN", "SHARED_PIN_AMBIGUOUS"] } },
        data: { latitude: null, longitude: null, geocode_match_type: p.was },
      });
      reverted += n.count;
    }
    console.log(`\n=== REVERTED ===\n  rows restored to their pre-change state: ${reverted}`);
    return;
  }

  // Fill-only on the coordinates: never overwrite a position that arrived
  // meanwhile from an admin fix, a batch run or the self-heal.
  let restored = 0;
  let marked = 0;
  for (const p of keep) {
    const n = await prisma.consignee.updateMany({
      where: { id: p.id, latitude: null, longitude: null },
      data: { latitude: p.lat, longitude: p.lng, geocode_match_type: "SHARED_PIN" },
    });
    restored += n.count;
  }
  for (const p of ambiguous) {
    const n = await prisma.consignee.updateMany({
      where: { id: p.id, latitude: null, longitude: null },
      data: { geocode_match_type: "SHARED_PIN_AMBIGUOUS" },
    });
    marked += n.count;
  }
  console.log(`\n=== WRITE ===`);
  console.log(`  pins restored          : ${restored}  (of ${keep.length} planned)`);
  console.log(`  marked ambiguous       : ${marked}  (of ${ambiguous.length} planned)`);
  // ⚠ NAME THE REASON, DO NOT ASSUME ONE. The first version called every
  // no-op "already had a position", which was a confident explanation of a
  // write that matched nothing at all. A row can fail to update because it
  // gained a coordinate meanwhile (fine) or because it is not there (a bug),
  // and those must not print the same sentence.
  const missed = keep.length - restored + (ambiguous.length - marked);
  if (missed > 0) {
    console.log(`  NOT updated            : ${missed}`);
    console.log(`     Either the row gained a position meanwhile (expected, harmless)`);
    console.log(`     or it is not there (a JOIN problem — check the gaps above).`);
    console.log(`     ⚠ Do not assume the first. Read the database.`);
  }
  console.log(`\n⚠ Verify by READING THE DATABASE, not from this summary.`);
}

main()
  .catch((e) => {
    console.error("FAILED:", String(e.message).replace(/postgresql:\/\/[^\s]+/g, "<url>"));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
