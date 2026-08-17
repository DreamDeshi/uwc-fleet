/**
 * Consignee geocoding — GOOGLE Geocoding API.
 *
 * Chosen over Geoapify after a 15-row bake-off + full census: Google returned
 * 989 trustworthy coordinates vs Geoapify's 450 (2.2×), collapses far fewer
 * distinct addresses onto one pin (worst cluster 7 vs 142), and exposes an
 * honest precision signal (`location_type`) — including ZERO postcode-centroid
 * dumps.
 *
 * Query = address_1 (+ address_2 for a leading C/O row) + area + postcode +
 * state + "Malaysia". company_name is NEVER sent (multi-site, ambiguous).
 *
 * Two gates on `location_type`, stored verbatim in `geocode_match_type`:
 *   STORABLE (isStorable)  ROOFTOP, RANGE_INTERPOLATED, GEOMETRIC_CENTER,
 *                          APPROXIMATE -> store the coordinate. Any position
 *                          the geocoder could place beats the zone centroid,
 *                          which is one shared dot per zone and up to 26.94 km
 *                          out. The GRADE travels with the row and readers ask
 *                          lib/geocodePrecision, so a street centre is drawn
 *                          and labelled as a street centre, never as a building.
 *   BUILDING (isUsable)    ROOFTOP, RANGE_INTERPOLATED only — the grade that
 *                          may be used to JUDGE a driver (lib/earlyTap), and
 *                          what the duplicate backstop below acts on.
 *   ZERO_RESULTS / errors  -> NULL. A non-answer carries no position, and
 *                          inventing one was always the thing to avoid.
 *
 * ⚠ THIS SCRIPT KEPT THE OLD SINGLE GATE UNTIL 18 Aug 2026, hours after the
 * rest of the codebase moved. `geocodeStoreFields` (creation-time) and this
 * write loop are two implementations of the same decision, and only the first
 * was widened — so a re-run would have silently discarded exactly the coarse
 * answers the change existed to keep, and reported success while doing it. The
 * shared helpers in src/lib exist to stop that, and this file wrote its own
 * `keep` expression instead of calling one.
 *
 * Duplicate-coordinate backstop: any USABLE row sharing a ~1 m pin with a
 * DIFFERENT address is demoted to NULL (a shared pin is a lie the gate can't
 * see). A usable location_type paired with NULL coords is therefore a demoted
 * duplicate — distinct from a coarse fallback (non-usable location_type).
 *
 * Flags: --dry-run (nothing written), --out <file> (dump per-row JSON),
 *   --from <file> (write from a prior --out dump, ZERO fresh API calls),
 *   --sample N, --only <file>. Guarded to a LOCAL db unless ALLOW_REMOTE_DB=1.
 */
import { prisma } from "../src/lib/prisma";
import { dbHostOf, isLocalDbHost, isProdDbHost } from "../src/lib/dbGuard";
// The query builder, precision gate and Google call live in src/lib so the
// batch script and creation-time geocoding (routes/consignees.ts) can never
// drift apart. This script keeps what is batch-only: pacing, --out/--from
// dumps, the duplicate-coordinate demotion backstop, and the summary.
import { buildQuery, googleGeocode, isCareOf, isUsable, isStorable } from "../src/lib/geocodeConsignee";
import { geocodePrecision } from "../src/lib/geocodePrecision";

const KEY = process.env.GOOGLE_MAPS_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
const DRY_RUN = process.argv.includes("--dry-run");
const OUT = (() => { const i = process.argv.indexOf("--out"); return i > -1 ? process.argv[i + 1] : ""; })();
const FROM = (() => { const i = process.argv.indexOf("--from"); return i > -1 ? process.argv[i + 1] : ""; })();
const SAMPLE = (() => { const i = process.argv.indexOf("--sample"); return i > -1 ? Number(process.argv[i + 1]) : 0; })();
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > -1 ? process.argv[i + 1] : ""; })();
const GAP_MS = Number(process.env.GEOCODE_GAP_MS ?? 70);

const nz = (s: string | null | undefined) => (s ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Safety: this WRITES, so it must not point at production by accident.
  const host = dbHostOf(process.env.DATABASE_URL);
  if (!host) throw new Error("DATABASE_URL is not set or unparseable.");
  const remoteOk = process.env.ALLOW_REMOTE_DB === "1";
  if ((!isLocalDbHost(host) || isProdDbHost(host)) && !remoteOk) {
    throw new Error(`Refusing to write geocodes to non-local database host "${host}". Set ALLOW_REMOTE_DB=1 to override.`);
  }
  console.log(`DB host      : ${host}${remoteOk ? "  (ALLOW_REMOTE_DB=1)" : "  (local)"}`);
  console.log(`Provider     : GOOGLE Geocoding`);
  console.log(`Mode         : ${DRY_RUN ? "DRY RUN — nothing will be written" : "WRITE"}`);

  const perRow: any[] = [];

  if (FROM) {
    perRow.push(...JSON.parse((await import("fs")).readFileSync(FROM, "utf8")));
    console.log(`Source       : --from ${FROM} → ${perRow.length} rows (no geocoding, no quota spent)\n`);
  } else {
    if (!KEY) throw new Error("GOOGLE_MAPS_KEY is not set. Export it before running (never hardcode it).");

    let rows = await prisma.consignee.findMany({
      select: { id: true, company_name: true, zone_code: true, address_1: true, address_2: true, area: true, state: true, postal_code: true },
      orderBy: { company_name: "asc" },
    });
    if (ONLY) {
      const wanted = new Set((await import("fs")).readFileSync(ONLY, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      rows = rows.filter((r) => wanted.has(r.company_name));
      console.log(`Filter       : --only ${ONLY} → ${rows.length} of ${wanted.size} names matched`);
    }
    if (SAMPLE > 0 && SAMPLE < rows.length) {
      const step = rows.length / SAMPLE;
      rows = Array.from({ length: SAMPLE }, (_, i) => rows[Math.floor(i * step)]);
      console.log(`Sample       : every ${step.toFixed(1)}th row → ${rows.length} rows`);
    }
    const careOf = rows.filter((r) => isCareOf(r.address_1)).length;
    console.log(`Consignees   : ${rows.length}  (${careOf} C/O rows will append address_2)\n`);

    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      const q = buildQuery(c);
      const g = await googleGeocode(q, KEY);
      await sleep(GAP_MS);
      const usable = isUsable(g.locationType);
      // ⚠ CAPTURE THE COORDINATE THE PROVIDER GAVE, UNGATED.
      //
      // This line used to read `lat: usable ? g.lat : null`, which threw the
      // road-level and area-level coordinates away HERE, before any gate could
      // choose to keep them — so widening the write gate below changed nothing
      // and the --out dump was already lossy. That is the same decision
      // implemented in a THIRD place, and it silently outranked the other two.
      //
      // The gate belongs at the WRITE (`keep`, below) and nowhere else. `usable`
      // is still recorded, because the duplicate backstop and the summary need
      // to know which rows are building grade.
      perRow.push({
        id: c.id, name: c.company_name, zone: c.zone_code, address_1: c.address_1, query: q,
        lat: g.lat, lng: g.lng, location_type: g.locationType, usable,
      });
      if ((i + 1) % 100 === 0 || i === rows.length - 1) console.log(`  ${String(i + 1).padStart(4)}/${rows.length} processed`);
    }
    if (OUT) {
      (await import("fs")).writeFileSync(OUT, JSON.stringify(perRow, null, 1), "utf8");
      console.log(`\nper-row results written to ${OUT}`);
    }
  }

  const N = perRow.length;

  // ── Summary ────────────────────────────────────────────────────────────────
  const tally: Record<string, number> = {};
  for (const r of perRow) tally[r.location_type] = (tally[r.location_type] ?? 0) + 1;
  console.log(`\n=== GOOGLE location_type ===`);
  const order = ["ROOFTOP", "RANGE_INTERPOLATED", "GEOMETRIC_CENTER", "APPROXIMATE", "ZERO_RESULTS"];
  const keys = [...new Set([...order.filter((k) => k in tally), ...Object.keys(tally)])];
  for (const k of keys) {
    const n = tally[k] ?? 0; if (!n) continue;
    const fate = isUsable(k) ? "BUILDING" : isStorable(k) ? `stored as ${geocodePrecision(k)}` : "-> zone fallback";
    console.log(`  ${k.padEnd(20)} ${String(n).padStart(5)}  ${((n / N) * 100).toFixed(1)}%  ${fate}`);
  }
  const usableTotal = perRow.filter((r) => isUsable(r.location_type)).length;
  // Counted on the COORDINATE, not on the verdict: a storable location_type
  // with a null lat stores nothing, and counting verdicts overstated this by 16
  // on the first A1 dry run — a summary that promised coordinates the write
  // could not deliver.
  const storableTotal = perRow.filter((r) => isStorable(r.location_type) && r.lat != null).length;
  console.log(`  ${"BUILDING grade".padEnd(20)} ${String(usableTotal).padStart(5)}  ${((usableTotal / N) * 100).toFixed(1)}%`);
  console.log(`  ${"STORABLE (any pin)".padEnd(20)} ${String(storableTotal).padStart(5)}  ${((storableTotal / N) * 100).toFixed(1)}%`);

  // ── Duplicate-coordinate audit ─────────────────────────────────────────────
  // BUILDING rows only — deliberately unchanged in meaning now that coarse
  // coordinates survive capture. Two identical ROOFTOP pins mean the geocoder
  // gave up; two identical street centres just mean one street, which is not a
  // defect and must not demote anything.
  const byCoord = new Map<string, typeof perRow>();
  for (const r of perRow) { if (r.lat == null || !isUsable(r.location_type)) continue; const k = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`; (byCoord.get(k) ?? byCoord.set(k, []).get(k)!).push(r); }
  const norm = (s: string) => nz(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const clusters = [...byCoord.entries()]
    .map(([coord, members]) => ({ coord, members, distinctAddresses: new Set(members.map((m) => norm(m.address_1))).size }))
    .filter((c) => c.members.length > 1 && c.distinctAddresses > 1)
    .sort((a, b) => b.members.length - a.members.length);
  const demotedIds = new Set<string>();
  for (const c of clusters) for (const m of c.members) if (isUsable(m.location_type)) demotedIds.add(m.id);
  console.log(`\n=== DUPLICATE-COORDINATE CLUSTERS ===`);
  console.log(`  clusters (same point, DIFFERENT addresses): ${clusters.length}`);
  console.log(`  usable rows demoted to zone fallback      : ${demotedIds.size}`);
  console.log(`  top: ${clusters.slice(0, 6).map((c) => `${c.members.length}/${c.distinctAddresses}@${c.coord}`).join("  ")}`);

  // ── Write ──────────────────────────────────────────────────────────────────
  console.log(`\n=== FINAL ===`);
  console.log(`  building grade         : ${usableTotal}`);
  console.log(`  duplicate-demoted      : ${demotedIds.size}  (building rows sharing one pin)`);
  console.log(`  storable (any position): ${storableTotal}`);
  console.log(`  will hold coordinates  : ${storableTotal - demotedIds.size}`);
  if (!DRY_RUN) {
    let updated = 0, withCoords = 0, nulled = 0;
    for (const r of perRow) {
      // STORABLE, not building-only: a street or postcode centre is kept and
      // labelled by its grade. The duplicate demotion still applies — a shared
      // pin is a lie at any grade — and it is computed from BUILDING rows,
      // because that backstop exists for coordinates precise enough that two
      // identical ones mean the geocoder gave up, not that two places are near.
      const keep = isStorable(r.location_type) && r.lat != null && !demotedIds.has(r.id);
      await prisma.consignee.update({
        where: { id: r.id },
        data: { latitude: keep ? r.lat : null, longitude: keep ? r.lng : null, geocode_match_type: r.location_type },
      });
      updated++;
      keep ? withCoords++ : nulled++;
    }
    console.log(`\n=== WRITE ===`);
    console.log(`  consignees updated                  : ${updated}`);
    console.log(`  with real coordinates               : ${withCoords}`);
    console.log(`  null coords (fallback + demoted dup) : ${nulled}`);
  }
}

// Run only when executed directly (npx tsx scripts/geocode-google.ts) — an
// import of this module must never fire a geocoding run (same guard as
// geocode-consignees.ts / self-heal-coords.ts).
if (require.main === module) {
  main()
    .catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
