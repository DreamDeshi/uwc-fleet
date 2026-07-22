/**
 * Geocode consignees to real building coordinates (Geoapify, offline, one-off).
 *
 * Today every trip destination is one of 8 hand-picked ZONE CENTROIDS, so 999
 * P2 consignees collapse onto a single dot. This fills Consignee.latitude /
 * .longitude / .geocode_match_type so the driver's navigate button and the admin
 * map can point at the actual building. There is NO runtime geocoding: this runs
 * offline, writes the columns, and the app reads them.
 *
 * ── The rules, all of them earned from a measured 4-provider bake-off ─────────
 *
 * 1. QUERY = address_1 + area + postal_code + state. **NEVER company_name.**
 *    Company names are multi-site and ambiguous (7 INTEL rows, 4 JABIL, 102
 *    brand families), and a "C/O <forwarder>" row would geocode to the wrong
 *    firm's building entirely.
 *
 * 2. C/O ROWS APPEND address_2. address_2 is normally a truncated duplicate of
 *    address_1 and is excluded as noise — but when address_1 starts with "C/O"
 *    it contains only a company name, and address_2 holds the ONLY real street
 *    text (e.g. Keysight's "GRID K8-K19, BLOCK B, CARGO COMPLEX"). Excluding it
 *    is precisely why every forwarder row failed on all four providers.
 *
 * 3. STORE match_type, NOT confidence. Geoapify's confidence lies — FRONTKEN
 *    returned conf=1.00 on what is plainly a postcode centroid. match_type is
 *    the honest field, and it is the gate:
 *      full_match / match_by_street  -> a real position
 *      match_by_postcode             -> NOT a geocode; a postcode centroid.
 *    We still STORE the postcode-centroid rows (coordinates + their match_type)
 *    so the failures are visible and re-runnable, but readers must refuse to
 *    navigate to anything that is not full_match/match_by_street.
 *
 * Idempotent: every row is UPDATEd in place by id, so re-running refreshes
 * rather than duplicating. Safe to stop and restart.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   $env:GEOAPIFY_KEY = "..."                       # never hardcode the key
 *   $env:DATABASE_URL = "postgresql://uwc:uwc@localhost:55432/uwc_test?schema=public"
 *   npx tsx scripts/geocode-consignees.ts           # add --dry-run to write nothing
 *
 * Guarded: refuses to run against a non-local database unless ALLOW_REMOTE_DB=1,
 * so a stray DATABASE_URL cannot rewrite production coordinates.
 */
import { prisma } from "../src/lib/prisma";
import { dbHostOf, isLocalDbHost, isProdDbHost } from "../src/lib/dbGuard";

const KEY = process.env.GEOAPIFY_KEY ?? "";
const DRY_RUN = process.argv.includes("--dry-run");
/**
 * --cascade sends only the STREET COMPONENT of address_1 (plus area/postcode/
 * state), falling back to postcode+area if that misses — the construction the
 * original 4-provider bake-off used. The default sends the whole address_1.
 * The two are NOT equivalent: ADCORD was a full_match under the cascade and a
 * fallback under the whole string, so this is worth measuring, not assuming.
 */
const CASCADE = process.argv.includes("--cascade");
/** --out <file>: dump every row's result as JSON (needed to audit duplicates). */
const OUT = (() => { const i = process.argv.indexOf("--out"); return i > -1 ? process.argv[i + 1] : ""; })();
/** --sample N: geocode a deterministic every-Nth subset — cheap quota-safe runs. */
const SAMPLE = (() => { const i = process.argv.indexOf("--sample"); return i > -1 ? Number(process.argv[i + 1]) : 0; })();
/** --only <file>: restrict to the company names listed one-per-line in <file>. */
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > -1 ? process.argv[i + 1] : ""; })();
// Geoapify free tier is 3,000/day; 1,561 rows fit in one run. ~4 req/s is
// comfortably inside their limits and polite.
const GAP_MS = Number(process.env.GEOCODE_GAP_MS ?? 250);

const nz = (s: string | null | undefined) => (s ?? "").trim();

/** True when address_1 is a "care of" line, i.e. a company, not a street. */
export function isCareOf(address1: string | null | undefined): boolean {
  return /^\s*c\s*\/\s*o\b/i.test(nz(address1));
}

/**
 * The geocoder query for one consignee. address_2 is appended ONLY for C/O rows
 * (see rule 2). company_name is never included.
 */
export function buildQuery(c: {
  address_1: string | null; address_2: string | null;
  area: string | null; state: string | null; postal_code: string | null;
}): string {
  const parts = [nz(c.address_1).replace(/,+\s*$/, "")];
  if (isCareOf(c.address_1) && nz(c.address_2)) parts.push(nz(c.address_2).replace(/,+\s*$/, ""));
  parts.push(nz(c.area), nz(c.postal_code), nz(c.state), "Malaysia");
  return parts.filter(Boolean).join(", ");
}

/** The --cascade variant: street component instead of the whole address_1. */
export function buildCascadeQuery(c: {
  address_1: string | null; address_2: string | null;
  area: string | null; state: string | null; postal_code: string | null;
}): string {
  // A C/O row's address_1 is a company, so its street still lives in address_2.
  const source = isCareOf(c.address_1) && nz(c.address_2) ? c.address_2 : c.address_1;
  return [streetOf(source), nz(c.area), nz(c.postal_code), nz(c.state), "Malaysia"].filter(Boolean).join(", ");
}

/**
 * The street component of address_1, for --cascade. These strings run their
 * parts together ("...5/1,TAMAN PERINDUSTRIAN BATU KAWAN"), so re-space on
 * commas and take the component that actually names a road.
 */
const STREET_WORD = /\b(JALAN|JLN|LORONG|LRG|LEBUH|PERSIARAN|SOLOK|LALUAN|MEDAN|LINTANG|TINGKAT|PLOT|LOT|PMT|KAWASAN|TAMAN)\b/i;
export function streetOf(address1: string | null | undefined): string {
  const parts = nz(address1).replace(/,(?=\S)/g, ", ").split(",").map((s) => s.trim()).filter(Boolean);
  const st = parts.find((p) => STREET_WORD.test(p) && !/^(NO\.?|LOT|PLOT|PMT)?\s*[\d\-/A-Z]{1,8}$/i.test(p));
  return st ?? parts[parts.length - 1] ?? "";
}

/**
 * Match types that represent a REAL position. Anything else is not a geocode.
 *
 * `match_by_building` was ADDED 2026-07-21 after the first full dry-run. The
 * original list came from a 20-row bake-off that never returned that type — it
 * was never a decision to exclude building matches, they simply had not been
 * seen, and a building match is STRICTLY MORE PRECISE than a street match.
 * Rejecting it discarded 115 rows (7.4%) in favour of a zone centroid.
 *
 * Still rejected on purpose:
 *   match_by_postcode         - a postcode centroid, not an address
 *   match_by_city_or_disrict  - coarser still (Geoapify's own spelling)
 *   inner_part                - matches something INSIDE the area rather than
 *                               the address; in the bake-off this returned
 *                               "Ambank Paya Terubong", ~1.5 km off target.
 */
export const ACCEPTED_MATCH_TYPES = ["full_match", "match_by_building", "match_by_street"];
export function isUsable(matchType: string | null | undefined): boolean {
  return ACCEPTED_MATCH_TYPES.includes(nz(matchType));
}

interface GeoResult { lat: number; lng: number; matchType: string; label: string }

async function geoapify(q: string): Promise<GeoResult | null> {
  const url =
    `https://api.geoapify.com/v1/geocode/search?limit=1&filter=countrycode:my` +
    `&text=${encodeURIComponent(q)}&apiKey=${KEY}`;
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) throw new Error(`Geoapify rejected the key (HTTP ${res.status})`);
  if (res.status === 429) throw new Error("Geoapify rate limit / daily quota hit (HTTP 429)");
  if (!res.ok) throw new Error(`Geoapify HTTP ${res.status}`);
  const f = (await res.json())?.features?.[0];
  if (!f) return null;
  const p = f.properties ?? {};
  return {
    lat: p.lat, lng: p.lon,
    // Deliberately NOT reading p.rank.confidence — see rule 3.
    matchType: nz(p.rank?.match_type) || "unknown",
    label: nz(p.formatted),
  };
}

async function main() {
  if (!KEY) throw new Error("GEOAPIFY_KEY is not set. Export it before running (never hardcode it).");

  // Safety: this WRITES, so it must not point at production by accident.
  const host = dbHostOf(process.env.DATABASE_URL);
  if (!host) throw new Error("DATABASE_URL is not set or unparseable.");
  const remoteOk = process.env.ALLOW_REMOTE_DB === "1";
  if ((!isLocalDbHost(host) || isProdDbHost(host)) && !remoteOk) {
    throw new Error(`Refusing to write geocodes to non-local database host "${host}". Set ALLOW_REMOTE_DB=1 to override.`);
  }
  console.log(`DB host      : ${host}${remoteOk ? "  (ALLOW_REMOTE_DB=1)" : "  (local)"}`);
  console.log(`Mode         : ${DRY_RUN ? "DRY RUN — nothing will be written" : "WRITE"}`);

  let rows = await prisma.consignee.findMany({
    select: { id: true, company_name: true, zone_code: true, address_1: true, address_2: true,
              area: true, state: true, postal_code: true },
    orderBy: { company_name: "asc" },
  });

  if (ONLY) {
    const wanted = new Set(
      (await import("fs")).readFileSync(ONLY, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    );
    rows = rows.filter((r) => wanted.has(r.company_name));
    console.log(`Filter       : --only ${ONLY} → ${rows.length} of ${wanted.size} names matched`);
  }
  if (SAMPLE > 0 && SAMPLE < rows.length) {
    // Every Nth row — deterministic and spread across the alphabet/zones, so the
    // sample is comparable between runs rather than a fresh random draw.
    const step = rows.length / SAMPLE;
    rows = Array.from({ length: SAMPLE }, (_, i) => rows[Math.floor(i * step)]);
    console.log(`Sample       : every ${step.toFixed(1)}th row → ${rows.length} rows`);
  }

  const careOf = rows.filter((r) => isCareOf(r.address_1)).length;
  console.log(`Query mode   : ${CASCADE ? "CASCADE (street component of address_1)" : "FULL address_1"}`);
  console.log(`Consignees   : ${rows.length}  (${careOf} C/O rows will append address_2)\n`);

  const tally: Record<string, number> = {};
  const fallbacks: { name: string; zone: string; query: string; label: string }[] = [];
  const failures: { name: string; reason: string }[] = [];
  let written = 0;

  const perRow: any[] = [];

  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const q = CASCADE ? buildCascadeQuery(c) : buildQuery(c);
    let g: GeoResult | null = null;
    try {
      g = await geoapify(q);
    } catch (err) {
      // A key/quota error is fatal — stop rather than burn through the list.
      const msg = String((err as Error).message);
      if (/key|quota|rate limit/i.test(msg)) throw err;
      failures.push({ name: c.company_name, reason: msg });
    }
    await new Promise((r) => setTimeout(r, GAP_MS));

    perRow.push({
      name: c.company_name, zone: c.zone_code, address_1: c.address_1, query: q,
      lat: g?.lat ?? null, lng: g?.lng ?? null, match_type: g?.matchType ?? "no_result",
      label: g?.label ?? "", usable: isUsable(g?.matchType),
    });

    if (!g) {
      tally["no_result"] = (tally["no_result"] ?? 0) + 1;
      failures.push({ name: c.company_name, reason: "no result" });
    } else {
      tally[g.matchType] = (tally[g.matchType] ?? 0) + 1;
      if (!isUsable(g.matchType)) {
        fallbacks.push({ name: c.company_name, zone: c.zone_code, query: q, label: g.label });
      }
      if (!DRY_RUN) {
        await prisma.consignee.update({
          where: { id: c.id },
          data: { latitude: g.lat, longitude: g.lng, geocode_match_type: g.matchType },
        });
        written++;
      }
    }

    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      console.log(`  ${String(i + 1).padStart(4)}/${rows.length} processed`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n=== MATCH TYPE SUMMARY ===`);
  const order = ["full_match", "match_by_street", "match_by_building", "match_by_postcode", "match_by_city_or_disrict", "unknown", "no_result"];
  const keys = [...new Set([...order.filter((k) => k in tally), ...Object.keys(tally)])];
  for (const k of keys) {
    const n = tally[k] ?? 0;
    if (!n) continue;
    const pct = ((n / rows.length) * 100).toFixed(1);
    console.log(`  ${k.padEnd(26)} ${String(n).padStart(5)}  ${pct.padStart(5)}%  ${isUsable(k) ? "USABLE" : "-> zone fallback"}`);
  }
  const usable = keys.filter(isUsable).reduce((s, k) => s + (tally[k] ?? 0), 0);
  console.log(`  ${"USABLE TOTAL".padEnd(26)} ${String(usable).padStart(5)}  ${((usable / rows.length) * 100).toFixed(1)}%`);
  if (!DRY_RUN) console.log(`  rows written: ${written}`);

  console.log(`\n=== POSTCODE-CENTROID FALLBACKS (${fallbacks.length}) — NOT usable, these keep zone behaviour ===`);
  for (const f of fallbacks) console.log(`  [${f.zone}] ${f.name}\n        q: ${f.query.slice(0, 110)}\n        -> ${f.label.slice(0, 90)}`);

  if (failures.length) {
    console.log(`\n=== NO RESULT / ERRORS (${failures.length}) ===`);
    for (const f of failures) console.log(`  ${f.name} — ${f.reason}`);
  }

  // ── Duplicate-coordinate audit ─────────────────────────────────────────────
  // A coordinate shared by consignees with DIFFERENT addresses is a lie the
  // match_type gate cannot see: ADCORD and both AWAN PACKAGING rows collapsed
  // onto one point measured 1,377 m from the true building, every one of them
  // wearing a confident match_type. Distinct sites must not share a pin.
  const byCoord = new Map<string, typeof perRow>();
  for (const r of perRow) {
    if (r.lat == null) continue;
    const k = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`; // ~1 m
    (byCoord.get(k) ?? byCoord.set(k, []).get(k)!).push(r);
  }
  const norm = (s: string) => nz(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const clusters = [...byCoord.entries()]
    .map(([coord, members]) => ({ coord, members, distinctAddresses: new Set(members.map((m) => norm(m.address_1))).size }))
    .filter((c) => c.members.length > 1 && c.distinctAddresses > 1)
    .sort((a, b) => b.members.length - a.members.length);

  const inClusters = clusters.reduce((s, c) => s + c.members.length, 0);
  console.log(`\n=== DUPLICATE-COORDINATE CLUSTERS ===`);
  console.log(`  clusters (same point, DIFFERENT addresses): ${clusters.length}`);
  console.log(`  rows involved                             : ${inClusters}  (${((inClusters / Math.max(perRow.length, 1)) * 100).toFixed(1)}%)`);
  const usableInClusters = clusters.reduce((s, c) => s + c.members.filter((m) => m.usable).length, 0);
  console.log(`  of those, currently GATED AS USABLE       : ${usableInClusters}  <-- these pass the gate while being wrong`);
  for (const c of clusters) {
    console.log(`\n  ${c.coord}  (${c.members.length} consignees, ${c.distinctAddresses} distinct addresses)`);
    console.log(`     https://www.google.com/maps/search/?api=1&query=${c.coord}`);
    for (const m of c.members) {
      console.log(`     ${m.usable ? "USABLE " : "rejected"} [${m.match_type}] ${m.name.slice(0, 44)}`);
      console.log(`              a1: ${nz(m.address_1).slice(0, 88)}`);
    }
  }

  if (OUT) {
    (await import("fs")).writeFileSync(OUT, JSON.stringify(perRow, null, 1), "utf8");
    console.log(`\nper-row results written to ${OUT}`);
  }
}

main()
  .catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); })
  .finally(() => prisma.$disconnect());
