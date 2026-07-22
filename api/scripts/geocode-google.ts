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
 * Gate on `location_type`, which is stored verbatim in `geocode_match_type`:
 *   ROOFTOP, RANGE_INTERPOLATED  -> USABLE (a real coordinate)
 *   GEOMETRIC_CENTER, APPROXIMATE, ZERO_RESULTS/errors -> NULL (zone fallback,
 *   honest coarse — never pretend a road/postcode centroid is a building)
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

const KEY = process.env.GOOGLE_MAPS_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
const DRY_RUN = process.argv.includes("--dry-run");
const OUT = (() => { const i = process.argv.indexOf("--out"); return i > -1 ? process.argv[i + 1] : ""; })();
const FROM = (() => { const i = process.argv.indexOf("--from"); return i > -1 ? process.argv[i + 1] : ""; })();
const SAMPLE = (() => { const i = process.argv.indexOf("--sample"); return i > -1 ? Number(process.argv[i + 1]) : 0; })();
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > -1 ? process.argv[i + 1] : ""; })();
const GAP_MS = Number(process.env.GEOCODE_GAP_MS ?? 70);

const nz = (s: string | null | undefined) => (s ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when address_1 is a "care of" line, i.e. a company, not a street. */
export function isCareOf(address1: string | null | undefined): boolean {
  return /^\s*c\s*\/\s*o\b/i.test(nz(address1));
}

/** The geocoder query for one consignee. address_2 appended ONLY for C/O rows. */
export function buildQuery(c: {
  address_1: string | null; address_2: string | null;
  area: string | null; state: string | null; postal_code: string | null;
}): string {
  const parts = [nz(c.address_1).replace(/,+\s*$/, "")];
  if (isCareOf(c.address_1) && nz(c.address_2)) parts.push(nz(c.address_2).replace(/,+\s*$/, ""));
  parts.push(nz(c.area), nz(c.postal_code), nz(c.state), "Malaysia");
  return parts.filter(Boolean).join(", ");
}

/** location_types that represent a REAL position. Anything else is not a geocode. */
export const USABLE_TYPES = ["ROOFTOP", "RANGE_INTERPOLATED"];
export function isUsable(locationType: string | null | undefined): boolean {
  return USABLE_TYPES.includes(nz(locationType));
}

interface GeoResult { lat: number | null; lng: number | null; locationType: string }

async function googleGeocode(q: string): Promise<GeoResult> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:MY&key=${KEY}`;
  for (let i = 0; i < 6; i++) {
    let j: any;
    try { j = await (await fetch(url)).json(); } catch { await sleep(1500); continue; }
    if (j.status === "OK" && j.results?.[0]) {
      const g = j.results[0];
      return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, locationType: g.geometry.location_type };
    }
    if (j.status === "ZERO_RESULTS") return { lat: null, lng: null, locationType: "ZERO_RESULTS" };
    // OVER_QUERY_LIMIT / UNKNOWN_ERROR / (freshly-enabled) REQUEST_DENIED → back off and retry
    if (["OVER_QUERY_LIMIT", "UNKNOWN_ERROR", "REQUEST_DENIED"].includes(j.status)) { await sleep(2000 * (i + 1)); continue; }
    return { lat: null, lng: null, locationType: j.status || "ERROR" };
  }
  return { lat: null, lng: null, locationType: "RETRY_EXHAUSTED" };
}

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
      const g = await googleGeocode(q);
      await sleep(GAP_MS);
      const usable = isUsable(g.locationType);
      perRow.push({
        id: c.id, name: c.company_name, zone: c.zone_code, address_1: c.address_1, query: q,
        lat: usable ? g.lat : null, lng: usable ? g.lng : null, location_type: g.locationType, usable,
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
    console.log(`  ${k.padEnd(20)} ${String(n).padStart(5)}  ${((n / N) * 100).toFixed(1)}%  ${isUsable(k) ? "USABLE" : "-> zone fallback"}`);
  }
  const usableTotal = perRow.filter((r) => isUsable(r.location_type)).length;
  console.log(`  ${"USABLE (gate)".padEnd(20)} ${String(usableTotal).padStart(5)}  ${((usableTotal / N) * 100).toFixed(1)}%`);

  // ── Duplicate-coordinate audit ─────────────────────────────────────────────
  const byCoord = new Map<string, typeof perRow>();
  for (const r of perRow) { if (r.lat == null) continue; const k = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`; (byCoord.get(k) ?? byCoord.set(k, []).get(k)!).push(r); }
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
  console.log(`  gate-usable            : ${usableTotal}`);
  console.log(`  duplicate-demoted      : ${demotedIds.size}`);
  console.log(`  real coordinates       : ${usableTotal - demotedIds.size}`);
  if (!DRY_RUN) {
    let updated = 0, withCoords = 0, nulled = 0;
    for (const r of perRow) {
      const keep = isUsable(r.location_type) && r.lat != null && !demotedIds.has(r.id);
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

main()
  .catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); })
  .finally(() => prisma.$disconnect());
