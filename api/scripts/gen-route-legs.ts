/**
 * Generate the pre-computed RouteLeg rows from a LOCALLY-RUN OpenRouteService.
 *
 * There is no hosted routing provider in this system: no API key, no account,
 * no quota, no third-party terms to comply with at runtime. Road geometry is
 * computed ONCE, here, and shipped as data in a migration.
 *
 * Why a finite table suffices: trips have no real destination coordinates
 * (Consignee stores zone_code only), so routes/trips.ts routes plant → each
 * stop's ZONE CENTROID. Every possible path is therefore a concatenation of
 * legs over {PLANT} ∪ {the 8 zone centroids} — 8 + 8x7 = 64 legs total.
 *
 * ── How to run ────────────────────────────────────────────────────────────
 *   1. Fetch an OSM extract covering the operating region, e.g.
 *      curl -L -o data/malaysia.osm.pbf \
 *        https://download.geofabrik.de/asia/malaysia-singapore-brunei-latest.osm.pbf
 *   2. Start ORS (first run builds the routing graph — several minutes):
 *      docker run -d --name uwc-ors -p 8080:8082 \
 *        -v "$PWD/data:/home/ors/files" -v "$PWD/graphs:/home/ors/graphs" \
 *        -e "ors.engine.profile_default.build.source_file=/home/ors/files/malaysia.osm.pbf" \
 *        -e "ors.engine.profile_default.graph_path=/home/ors/graphs" \
 *        -e "ors.engine.profiles.driving-hgv.enabled=true" \
 *        -e "ors.endpoints.routing.maximum_distance=1000000" \
 *        openrouteservice/openrouteservice:latest
 *   3. npx tsx scripts/gen-route-legs.ts <path-to-migration.sql>
 *
 * maximum_distance is NOT optional: ORS defaults to a 100 km cap and rejects
 * anything longer with error 2004. The KL leg is ~350 km, so without it the run
 * dies partway. (The graph is cached in the mounted graphs/ volume, so a restart
 * to change this setting reloads in seconds rather than rebuilding.)
 *
 * The run is all-or-nothing on purpose: a failed leg aborts before anything is
 * written, so a migration can never ship with a partial set of routes.
 *
 * The script APPENDS INSERT statements to the given migration file. To refresh
 * the data later, ship a NEW migration — never edit an applied one.
 *
 * driving-hgv is deliberate: this is a lorry fleet, and the HGV profile honours
 * height/weight/axle restrictions. Google's Directions API has no truck routing.
 */
import fs from "fs";
import { PLANT_ORIGIN, ZONE_COORDS, type LatLng } from "../src/lib/geo";

const ORS = process.env.ORS_URL ?? "http://localhost:8080";
const PROFILE = process.env.ORS_PROFILE ?? "driving-hgv";

const PLANT_KEY = "PLANT";
const points: Record<string, LatLng> = { [PLANT_KEY]: PLANT_ORIGIN, ...ZONE_COORDS };

interface Leg {
  from: string;
  to: string;
  polyline: string;
  distance_m: number;
  duration_s: number;
}

/** One ORS call. Note ORS takes [lng, lat] — the REVERSE of Google's lat,lng. */
async function routeLeg(from: LatLng, to: LatLng): Promise<Omit<Leg, "from" | "to">> {
  const res = await fetch(`${ORS}/ors/v2/directions/${PROFILE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      coordinates: [
        [from.longitude, from.latitude],
        [to.longitude, to.latitude],
      ],
      // Zone centroids are arbitrary points (a town centre, sometimes water or
      // scrub), so let ORS snap to the nearest routable road however far it is.
      radiuses: [-1, -1],
    }),
  });
  if (!res.ok) {
    throw new Error(`ORS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    routes: { summary: { distance: number; duration: number }; geometry: string }[];
  };
  const route = data.routes?.[0];
  if (!route) throw new Error("ORS returned no route");
  return {
    polyline: route.geometry,
    distance_m: Math.round(route.summary.distance),
    duration_s: Math.round(route.summary.duration),
  };
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main() {
  const target = process.argv[2];
  if (!target) throw new Error("usage: tsx scripts/gen-route-legs.ts <migration.sql>");

  // ORS version, recorded per row so an odd leg can be traced to its generator.
  const statusRes = await fetch(`${ORS}/ors/v2/health`).catch(() => null);
  if (!statusRes?.ok) throw new Error(`ORS not reachable at ${ORS} — is the container up?`);
  let version = "unknown";
  try {
    const info = (await (await fetch(`${ORS}/ors/v2/status`)).json()) as { engine?: { version?: string } };
    version = info.engine?.version ?? "unknown";
  } catch {
    /* status is optional — the legs are what matter */
  }
  const generator = `openrouteservice ${version} (docker, ${PROFILE})`;
  const generatedAt = new Date().toISOString();

  // PLANT → every zone, and every zone → every OTHER zone. A multi-stop trip is
  // the concatenation of these legs, so 64 rows cover paths of any length.
  const pairs: [string, string][] = [];
  for (const zone of Object.keys(ZONE_COORDS)) pairs.push([PLANT_KEY, zone]);
  for (const a of Object.keys(ZONE_COORDS)) {
    for (const b of Object.keys(ZONE_COORDS)) {
      if (a !== b) pairs.push([a, b]);
    }
  }

  const legs: Leg[] = [];
  for (const [from, to] of pairs) {
    const leg = await routeLeg(points[from], points[to]);
    legs.push({ from, to, ...leg });
    console.log(
      `${from.padEnd(5)} → ${to.padEnd(3)}  ${(leg.distance_m / 1000).toFixed(1).padStart(6)} km  ` +
        `${String(Math.round(leg.duration_s / 60)).padStart(4)} min  ${leg.polyline.length} chars`
    );
  }

  const values = legs
    .map((l) => {
      const a = points[l.from];
      const b = points[l.to];
      return (
        `  (${sqlString(l.from)}, ${sqlString(l.to)}, ${sqlString(l.polyline)}, ${l.distance_m}, ${l.duration_s}, ` +
        `${sqlString(PROFILE)}, ${sqlString(generator)}, ${sqlString(generatedAt)}::timestamp, ` +
        `${a.latitude}, ${a.longitude}, ${b.latitude}, ${b.longitude})`
      );
    })
    .join(",\n");

  const sql =
    `\n-- ${legs.length} legs generated ${generatedAt} by ${generator}\n` +
    `-- from PLANT_ORIGIN + ZONE_COORDS as of this migration (see api/src/lib/geo.ts).\n` +
    `INSERT INTO "RouteLeg" ("from_key","to_key","polyline","distance_m","duration_s",` +
    `"profile","generator","generated_at","from_lat","from_lng","to_lat","to_lng") VALUES\n${values};\n`;

  fs.appendFileSync(target, sql);
  console.log(`\n✔ appended ${legs.length} legs to ${target}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
