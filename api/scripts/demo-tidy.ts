/**
 * DEMO-ONLY tidy-up: leave the demo looking like a real operation on a normal
 * day rather than a test environment full of debris.
 *
 * ⚠ IT CANNOT TOUCH PRODUCTION, AND THERE IS NO OVERRIDE. The gate asks the
 * database to prove it is the demo, positively — every truck plate matches
 * UWC 10xx (production carries nine real plates) and the consignee count is
 * demo-sized (production is four-figure). Production fails both.
 *
 * ⚠ CONNECT TO THE RIGHT DATABASE. This server hosts three: `postgres`,
 * `railway` and `uwc_demo`. Railway's own POSTGRES_DB/PGDATABASE variables say
 * `railway`, which is the platform default and is EMPTY — building a URL from
 * them lands in a database with zero tables and reads as "the app isn't here".
 * The API's DATABASE_URL is a LITERAL ending in /uwc_demo. Use that one.
 *
 * Reference data is never touched: users, trucks, zones, rates, consignees.
 * Only trips and their own children are removed.
 *
 *   npx tsx scripts/demo-tidy.ts            # plan only, deletes nothing
 *   npx tsx scripts/demo-tidy.ts --apply    # delete
 */
import { prisma } from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");
const PLACEHOLDER = /\btest\b|asdf|qwer|xxx|dummy|lorem|placeholder|123123/i;
const KEEP_ASSIGNED = 2;

async function assertDemo() {
  const plates = (await prisma.truck.findMany({ select: { plate: true } })).map((t) => t.plate);
  const consignees = await prisma.consignee.count();
  const db = (await prisma.$queryRawUnsafe<any[]>(`SELECT current_database() AS db`))[0].db;
  if (plates.length === 0 || plates.some((p) => !/^UWC 10\d\d$/.test(p))) {
    console.error(`REFUSING: database "${db}" has non-demo plates. Nothing was deleted.`);
    process.exit(2);
  }
  if (consignees >= 1000) {
    console.error(`REFUSING: ${consignees} consignees is production's count. Nothing was deleted.`);
    process.exit(2);
  }
  console.log(`Gate passed — DEMO (database "${db}", ${plates.length} synthetic plates, ${consignees} consignees)\n`);
}

async function main() {
  await assertDemo();

  const trips = await prisma.trip.findMany({
    include: { stops: { include: { consignee: { select: { company_name: true } } } }, driver: { select: { name: true } } },
    orderBy: { ticket_number: "asc" },
  });

  const keep: typeof trips = [];
  const drop: { trip: (typeof trips)[number]; why: string }[] = [];
  let assignedKept = 0;

  // Newest assigned first, so the two that survive are the freshest.
  const assignedNewestFirst = [...trips]
    .filter((t) => t.status === "assigned")
    .sort((a, b) => (a.ticket_number > b.ticket_number ? -1 : 1))
    .slice(0, KEEP_ASSIGNED)
    .map((t) => t.id);

  for (const t of trips) {
    const names = t.stops.map((s) => s.consignee?.company_name ?? "").join(" ");
    // Trip carries no free-text remarks column, so consignee names are the
    // only place placeholder junk can show up in this data.
    const junk = PLACEHOLDER.test(names);
    if (junk) { drop.push({ trip: t, why: "placeholder text" }); continue; }
    if (t.stops.length === 0) { drop.push({ trip: t, why: "no stops — renders as an empty card" }); continue; }
    if (t.status === "cancelled") { drop.push({ trip: t, why: "cancelled — dead end" }); continue; }
    if (t.status === "assigned") {
      if (assignedNewestFirst.includes(t.id)) { keep.push(t); assignedKept++; }
      else drop.push({ trip: t, why: `surplus assigned (keeping ${KEEP_ASSIGNED})` });
      continue;
    }
    keep.push(t);
  }

  const line = (t: (typeof trips)[number]) =>
    `${t.ticket_number}  ${String(t.status).padEnd(16)} stops=${t.stops.length} drv=${t.driver?.name ?? "-"}`;

  console.log(`KEEP (${keep.length}):`);
  for (const t of keep) console.log(`  ${line(t)}`);
  console.log(`\nREMOVE (${drop.length}):`);
  for (const d of drop) console.log(`  ${line(d.trip)}  ← ${d.why}`);

  if (!APPLY) { console.log(`\nPLAN ONLY — nothing deleted. Re-run with --apply.`); return; }

  const ids = drop.map((d) => d.trip.id);
  if (ids.length === 0) { console.log("\nNothing to remove."); return; }

  // Children first: no cascade is declared anywhere on these relations.
  const excIds = (await prisma.tripException.findMany({ where: { trip_id: { in: ids } }, select: { id: true } })).map((e) => e.id);

  await prisma.$transaction([
    prisma.exceptionEvidence.deleteMany({ where: { exception_id: { in: excIds } } }),
    prisma.exceptionAction.deleteMany({ where: { exception_id: { in: excIds } } }),
    prisma.tripException.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.tripStatusHistory.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.locationLog.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.tripDocument.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.tripChangeRequest.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.cargoDetail.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.externalForwarder.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.tripStop.deleteMany({ where: { trip_id: { in: ids } } }),
    prisma.trip.deleteMany({ where: { id: { in: ids } } }),
  ]);

  const after = await prisma.trip.count();
  const byStatus = await prisma.trip.groupBy({ by: ["status"], _count: { _all: true } });
  console.log(`\n=== DONE ===\n  trips before : ${trips.length}\n  removed      : ${ids.length}\n  trips after  : ${after}`);
  console.log(`  by status    : ${byStatus.map((s) => `${s.status}=${s._count._all}`).join(", ")}`);
}

main().catch((e) => { console.error("FAILED:", String(e.message).split("\n")[0]); process.exit(1); })
  .finally(() => prisma.$disconnect());
