/**
 * Fleet-map visual fixture — LOCAL TEST DB ONLY.
 *
 * The admin fleet map draws a truck one of three ways, and the difference is
 * pure styling, so a static check can't prove it. This creates all three states
 * side by side on the throwaway Docker DB so the map can be eyeballed without
 * touching prod:
 *
 *   LIVE   — in_progress trip + a GPS fix seconds old  → coloured pill, green
 *            live dot, solid border, drawn at the real coordinates.
 *   STALE  — in_progress trip + a fix ~25 min old (> GPS_STALE_AFTER_MS)
 *            → still coloured and still at the real last-known coordinates,
 *            but no live dot and a dashed border.
 *   GHOST  — no trip, therefore no fix at all → grey, faded, "~" prefix, drawn
 *            on its priority zone's CENTROID. A placeholder, not a location.
 *
 * The fake fixes are deliberately placed on plausible road positions AWAY from
 * the zone centroids, so a real fix is visibly distinguishable from a ghost.
 *
 * ⚠ The LIVE state EXPIRES: "fresh" means < GPS_STALE_AFTER_MS (3 minutes), so
 * a fixture seeded more than 3 minutes before you look at the map shows its
 * live trucks as STALE. Re-run this immediately before capturing/eyeballing.
 *
 * Guarded: refuses production outright, needs ALLOW_DESTRUCTIVE=1 elsewhere
 * (it deletes existing trips first). Run via:
 *   npm run seed:map-fixture      (from api/, DATABASE_URL → the test DB)
 */
import { prisma } from "../src/lib/prisma";
import { assertDestructiveAllowed } from "./destructive-guard";

// Plate → the fix to give it. `agoMinutes: null` means NO fix at all (ghost).
// GPS_STALE_AFTER_MS is 3 min, so 25 min is comfortably stale.
const FIXTURES: { plate: string; zone: string; lat: string; lng: string; agoMinutes: number | null; note: string }[] = [
  // LIVE — mid-span of the Penang Bridge, nowhere near a centroid.
  { plate: "PND 1888", zone: "P1", lat: "5.3553000", lng: "100.3612000", agoMinutes: 0, note: "live · Penang Bridge" },
  // LIVE — on the North-South Expressway heading south to Taiping.
  { plate: "PLX 2406", zone: "A1", lat: "5.1120000", lng: "100.5480000", agoMinutes: 1, note: "live · NSE southbound" },
  // STALE — last seen on the trunk road north of Sungai Petani 25 min ago.
  { plate: "PQL 5292", zone: "K2", lat: "5.5510000", lng: "100.5020000", agoMinutes: 25, note: "stale · north of SP" },
  // The remaining trucks (4 Wheel, PPE 1804, PRH 5292, PRJ 5292) get no trip
  // and no fix, so the map ghosts them onto their zone centroids.
];

async function main() {
  assertDestructiveAllowed("seed-map-fixture");

  const requestor = await prisma.user.findFirst({ where: { role: "requestor" }, orderBy: { created_at: "asc" } });
  if (!requestor) throw new Error("No requestor found — run `npm run seed:test` first.");

  const routeType = await prisma.routeType.findFirst();
  if (!routeType) throw new Error("No route types — run the main seed first.");

  // Clean slate so the map shows exactly this fixture and nothing else.
  const existing = await prisma.trip.findMany({ select: { id: true } });
  const ids = existing.map((t) => t.id);
  await prisma.locationLog.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.tripStatusHistory.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.cargoDetail.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.tripStop.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.trip.deleteMany({ where: { id: { in: ids } } });
  console.log(`Cleared ${ids.length} existing trip(s).`);

  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  let seq = 900;

  for (const f of FIXTURES) {
    const truck = await prisma.truck.findUnique({ where: { plate: f.plate }, select: { plate: true } });
    if (!truck) throw new Error(`Truck ${f.plate} not found — run the main seed first.`);

    const driver = await prisma.user.findFirst({
      where: { role: "driver", assigned_truck_plate: f.plate },
      select: { id: true, name: true },
    });
    if (!driver) throw new Error(`No driver assigned to ${f.plate}.`);

    const consignee = await prisma.consignee.findFirst({ where: { zone_code: f.zone }, orderBy: { company_name: "asc" } });
    if (!consignee) throw new Error(`No consignee in zone ${f.zone}.`);

    const pickup = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const trip = await prisma.trip.create({
      data: {
        ticket_number: `TKT-${ymd}-${++seq}`,
        requestor_id: requestor.id,
        driver_id: driver.id,
        truck_plate: f.plate,
        route_type_id: routeType.id,
        status: "in_progress",
        pickup_datetime: pickup,
        stops: { create: [{ sequence: 1, consignee_id: consignee.id, status: "pending" }] },
        cargo_details: { create: [{ pallet_type: "4×4", quantity: 4 }] },
      },
      select: { id: true },
    });

    await prisma.locationLog.create({
      data: {
        trip_id: trip.id,
        driver_id: driver.id,
        latitude: f.lat,
        longitude: f.lng,
        recorded_at: new Date(now.getTime() - (f.agoMinutes ?? 0) * 60 * 1000),
        source: "phone",
      },
    });

    console.log(`${f.plate.padEnd(9)} → ${f.note} (${f.lat}, ${f.lng}) · ${driver.name}`);
  }

  const ghosts = await prisma.truck.findMany({
    where: { plate: { notIn: FIXTURES.map((f) => f.plate) } },
    select: { plate: true, priority_zones: true },
  });
  for (const g of ghosts) {
    console.log(`${g.plate.padEnd(9)} → ghost · zone centroid ${g.priority_zones[0] ?? "P2 (no priority zones → default)"}`);
  }

  console.log(`\n✔ Map fixture ready: ${FIXTURES.length} trucks with a fix, ${ghosts.length} ghosted.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
