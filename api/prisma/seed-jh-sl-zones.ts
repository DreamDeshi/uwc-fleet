/**
 * Targeted, idempotent insert of the two long-haul zones added per the spec
 * REQUESTOR INTERFACE: Johor (JH) and Selangor (SL), each worth 8 destination
 * points (matching KL). This does NOT wipe or touch anything else — it only
 * upserts the two zones and creates their destination rates if missing.
 *
 * Run with: npx tsx prisma/seed-jh-sl-zones.ts   (uses DATABASE_URL from .env)
 */
import { prisma } from "../src/lib/prisma";

const ZONES = [
  { code: "JH", name: "Johor" },
  { code: "SL", name: "Selangor" },
];

const DESTINATION_RATES = [
  { zone_code: "JH", location_name: "Johor", points: 8 },
  { zone_code: "SL", location_name: "Selangor", points: 8 },
];

async function main() {
  for (const zone of ZONES) {
    await prisma.zone.upsert({
      where: { code: zone.code },
      update: { name: zone.name },
      create: zone,
    });
    console.log(`Zone ${zone.code} (${zone.name}) ensured.`);
  }

  for (const rate of DESTINATION_RATES) {
    const exists = await prisma.destinationRate.findFirst({
      where: { location_name: rate.location_name },
    });
    if (exists) {
      console.log(`Destination rate "${rate.location_name}" already exists — skipped.`);
    } else {
      await prisma.destinationRate.create({ data: rate });
      console.log(`Destination rate "${rate.location_name}" (${rate.points} pts) created.`);
    }
  }

  // Verify final state.
  const zones = await prisma.zone.findMany({
    where: { code: { in: ["JH", "SL"] } },
    select: { code: true, name: true },
  });
  const rates = await prisma.destinationRate.findMany({
    where: { location_name: { in: ["Johor", "Selangor"] } },
    select: { location_name: true, zone_code: true, points: true },
  });
  console.log("Zones now present:", zones);
  console.log("Rates now present:", rates);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
