/**
 * ~200 demo consignees with REAL geography, for the public SDG demo.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * The demo shipped with 10 consignees and no coordinates. Every stop therefore
 * fell back to its zone centroid, so the driver screen carried "Approximate —
 * zone centre, check the address", "Drive there in Google Maps" aimed at the
 * middle of a district, and the fleet map showed a handful of pins in a region
 * that really contains hundreds of delivery points. It looked like a prototype
 * because it was shaped like one.
 *
 * ── Real PLACES, invented COMPANIES ───────────────────────────────────────
 * The customer list is NDA-confidential and must never reach a public instance,
 * so nothing here is copied from it. What is real is the GEOGRAPHY: each
 * consignee sits in an actual industrial estate or township in the northern
 * corridor, at a coordinate inside that estate. Navigation therefore takes a
 * driver to the right place, and the map shows the true shape of the operating
 * area — while every company name is generated and belongs to no one.
 *
 * Names are deliberately of the form "<Area> <Sector> <NN>" — "Juru Electronics
 * 07". They read naturally in a stop list and on a map, they tell the viewer
 * where the drop is, and they cannot be mistaken for a specific real firm the
 * way an invented "… Sdn Bhd" could. A demo that is anonymous only to people
 * who already know which names are fake is not anonymous.
 *
 * ⚠ PHONES ARE LEFT NULL, DELIBERATELY. A realistic-looking Malaysian mobile
 * number is somebody's actual number, and this instance is handed to a room of
 * strangers with a "Call consignee" button on the driver screen. There is no
 * reserved test range to use, so the honest answer is no number at all.
 *
 * ⚠ Coordinates are NOT rounded here. The 2dp rounding rule applies to
 * publishing REAL customer positions on the poster; these positions are
 * invented, and navigation needs the precision.
 *
 * Idempotent: every row it owns carries a DEMO- vendor_code, and only those are
 * cleared on a re-run. Rows referenced by an existing trip stop are kept, so a
 * seeded demo can be refreshed without breaking its own trips.
 *
 * Run with: ALLOW_DESTRUCTIVE=1 npx tsx prisma/seed-demo-consignees.ts
 *           (from api/, non-prod DATABASE_URL only)
 */
import { prisma } from "../src/lib/prisma";
import { assertDestructiveAllowed } from "./destructive-guard";

interface Area {
  /** Real place name, used for the address and the generated company name. */
  name: string;
  lat: number;
  lng: number;
  postcode: string;
  state: string;
  /** How many consignees to place here. */
  count: number;
}

// Real industrial estates and townships, with their approximate centres. The
// mix is weighted to the Penang corridor because that is where the fleet
// actually works — the long-haul zones get a handful each so the zone filter
// and the long-haul rate have something to show, not an even split that would
// misrepresent the operation.
const AREAS: Record<string, Area[]> = {
  P1: [
    { name: "Bayan Lepas", lat: 5.3236, lng: 100.2926, postcode: "11900", state: "Pulau Pinang", count: 16 },
    { name: "Bayan Baru", lat: 5.3327, lng: 100.296, postcode: "11950", state: "Pulau Pinang", count: 9 },
    { name: "Batu Maung", lat: 5.283, lng: 100.29, postcode: "11960", state: "Pulau Pinang", count: 7 },
    { name: "Gelugor", lat: 5.369, lng: 100.305, postcode: "11700", state: "Pulau Pinang", count: 8 },
    { name: "George Town", lat: 5.4141, lng: 100.3288, postcode: "10200", state: "Pulau Pinang", count: 8 },
    { name: "Jelutong", lat: 5.386, lng: 100.317, postcode: "11600", state: "Pulau Pinang", count: 7 },
  ],
  P2: [
    { name: "Perai", lat: 5.38, lng: 100.4, postcode: "13600", state: "Pulau Pinang", count: 16 },
    { name: "Juru", lat: 5.305, lng: 100.435, postcode: "14100", state: "Pulau Pinang", count: 12 },
    { name: "Bukit Minyak", lat: 5.33, lng: 100.456, postcode: "14100", state: "Pulau Pinang", count: 11 },
    { name: "Bukit Mertajam", lat: 5.363, lng: 100.466, postcode: "14000", state: "Pulau Pinang", count: 10 },
    { name: "Batu Kawan", lat: 5.256, lng: 100.42, postcode: "14110", state: "Pulau Pinang", count: 6 },
    { name: "Simpang Ampat", lat: 5.282, lng: 100.477, postcode: "14100", state: "Pulau Pinang", count: 5 },
    { name: "Seberang Jaya", lat: 5.39, lng: 100.396, postcode: "13700", state: "Pulau Pinang", count: 5 },
  ],
  P3: [
    { name: "Tasek Gelugor", lat: 5.4669, lng: 100.4884, postcode: "13300", state: "Pulau Pinang", count: 8 },
    { name: "Kepala Batas", lat: 5.517, lng: 100.426, postcode: "13200", state: "Pulau Pinang", count: 7 },
    { name: "Bertam", lat: 5.545, lng: 100.457, postcode: "13200", state: "Pulau Pinang", count: 5 },
  ],
  K1: [
    { name: "Kulim Hi-Tech Park", lat: 5.373, lng: 100.56, postcode: "09000", state: "Kedah", count: 12 },
    { name: "Kulim", lat: 5.3653, lng: 100.5618, postcode: "09000", state: "Kedah", count: 8 },
    { name: "Lunas", lat: 5.313, lng: 100.607, postcode: "09600", state: "Kedah", count: 5 },
  ],
  K2: [
    { name: "Sungai Petani", lat: 5.6497, lng: 100.4878, postcode: "08000", state: "Kedah", count: 10 },
    { name: "Bakar Arang", lat: 5.63, lng: 100.5, postcode: "08000", state: "Kedah", count: 6 },
    { name: "Bedong", lat: 5.71, lng: 100.51, postcode: "08100", state: "Kedah", count: 4 },
  ],
  A1: [
    { name: "Kamunting", lat: 4.88, lng: 100.73, postcode: "34600", state: "Perak", count: 4 },
    { name: "Taiping", lat: 4.8501, lng: 100.738, postcode: "34000", state: "Perak", count: 3 },
  ],
  A2: [
    { name: "Tasek", lat: 4.63, lng: 101.12, postcode: "31400", state: "Perak", count: 4 },
    { name: "Ipoh", lat: 4.5975, lng: 101.0901, postcode: "30000", state: "Perak", count: 3 },
  ],
  KL: [
    { name: "Shah Alam", lat: 3.073, lng: 101.518, postcode: "40000", state: "Selangor", count: 2 },
    { name: "Klang", lat: 3.045, lng: 101.445, postcode: "41000", state: "Selangor", count: 2 },
  ],
};

const SECTORS = [
  "Electronics", "Precision", "Packaging", "Components", "Plastics",
  "Engineering", "Automation", "Metalworks", "Assembly", "Logistics",
  "Semiconductor", "Fabrication",
];

/**
 * Deterministic jitter in the range ±`spread` degrees, derived from the row's
 * own index. Deterministic rather than random so a re-seed reproduces the same
 * map — a demo whose pins jump every run is harder to talk about, and a
 * screenshot taken today should still match the instance tomorrow.
 */
function jitter(seed: number, spread: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * spread;
}

async function main() {
  assertDestructiveAllowed("seed-demo-consignees");

  const zones = new Set((await prisma.zone.findMany({ select: { code: true } })).map((z) => z.code));

  // ── Clear only the rows this script owns, and only if unused ─────────────
  const mine = await prisma.consignee.findMany({
    where: { vendor_code: { startsWith: "DEMO-" } },
    select: { id: true },
  });
  const used = new Set(
    (
      await prisma.tripStop.findMany({
        where: { consignee_id: { in: mine.map((m) => m.id) } },
        select: { consignee_id: true },
      })
    ).map((s) => s.consignee_id)
  );
  const removable = mine.filter((m) => !used.has(m.id)).map((m) => m.id);
  if (removable.length) {
    await prisma.consignee.deleteMany({ where: { id: { in: removable } } });
  }
  console.log(`Cleared ${removable.length} previous demo consignee(s); kept ${used.size} still used by a trip.`);

  // ── Build ────────────────────────────────────────────────────────────────
  const rows: Array<{
    company_name: string;
    vendor_code: string;
    address_1: string;
    area: string;
    state: string;
    postal_code: string;
    zone_code: string;
    latitude: number;
    longitude: number;
    geocode_match_type: string;
  }> = [];

  let n = 0;
  for (const [zone, areas] of Object.entries(AREAS)) {
    if (!zones.has(zone)) {
      console.log(`  skipping zone ${zone} — not present on this instance`);
      continue;
    }
    for (const a of areas) {
      for (let i = 0; i < a.count; i++) {
        n += 1;
        const sector = SECTORS[n % SECTORS.length];
        const seq = String(i + 1).padStart(2, "0");
        rows.push({
          company_name: `${a.name} ${sector} ${seq}`,
          vendor_code: `DEMO-${zone}-${String(n).padStart(3, "0")}`,
          // A plausible industrial address. The LOT number is invented; the
          // road-name pattern, area, postcode and state are real for the place.
          address_1: `Lot ${100 + ((n * 7) % 800)}, Jalan Perusahaan ${1 + (n % 9)}`,
          area: a.name,
          state: a.state,
          postal_code: a.postcode,
          zone_code: zone,
          // ~±0.012° ≈ 1.3 km: inside the estate, never on top of a neighbour.
          latitude: Number((a.lat + jitter(n, 0.012)).toFixed(6)),
          longitude: Number((a.lng + jitter(n + 1000, 0.012)).toFixed(6)),
          // Provenance only. NOTHING gates on this — see the schema comment.
          geocode_match_type: "demo_synthetic",
        });
      }
    }
  }

  await prisma.consignee.createMany({ data: rows });

  const byZone = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.zone_code] = (acc[r.zone_code] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Created ${rows.length} demo consignees, all with coordinates:`);
  for (const [z, c] of Object.entries(byZone)) console.log(`  ${z.padEnd(3)} ${c}`);
  console.log("Demo consignees ready.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
