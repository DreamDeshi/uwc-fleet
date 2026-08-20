/**
 * DEMO-ONLY: make the seeded accounts' display names match the one canonical
 * source, `prisma/demoIdentities.json`.
 *
 * ⚠ IT CANNOT TOUCH PRODUCTION, AND THERE IS NO OVERRIDE. The gate asks the
 * database to prove it is the demo, positively — every truck plate matches
 * UWC 10xx (production carries nine real plates) and the consignee count is
 * demo-sized (production is four-figure). Production fails both. Same gate as
 * scripts/demo-tidy.ts.
 *
 * WHY A SCRIPT RATHER THAN A HAND-EDIT. A name typed straight into the database
 * is correct until the next seed run, and there is no record of what it should
 * have been. This reads the shared file, so a re-seed that reintroduces a stray
 * name is fixed by running this again rather than by remembering.
 *
 * WHY A SCRIPT RATHER THAN A RE-SEED. The demo seed cannot be re-run on a demo
 * that has been used — it fails part-way and leaves trips without stops. This
 * touches nothing but `User.name`.
 *
 *   npx tsx scripts/demo-apply-identities.ts            # plan only
 *   npx tsx scripts/demo-apply-identities.ts --apply    # write
 */
import { prisma } from "../src/lib/prisma";
import identities from "../prisma/demoIdentities.json";

const APPLY = process.argv.includes("--apply");

async function assertDemo() {
  const plates = (await prisma.truck.findMany({ select: { plate: true } })).map((t) => t.plate);
  const consignees = await prisma.consignee.count();
  const db = (await prisma.$queryRawUnsafe<{ db: string }[]>(`SELECT current_database() AS db`))[0].db;
  if (plates.length === 0 || plates.some((p) => !/^UWC 10\d\d$/.test(p))) {
    console.error(`REFUSING: database "${db}" has non-demo plates. Nothing written.`);
    process.exit(2);
  }
  if (consignees >= 1000) {
    console.error(`REFUSING: ${consignees} consignees is production's count. Nothing written.`);
    process.exit(2);
  }
  console.log(`Gate passed — DEMO (database "${db}", ${plates.length} synthetic plates, ${consignees} consignees)\n`);
}

async function main() {
  await assertDemo();

  const wanted: [string, string, string][] = [
    ...Object.entries(identities.drivers).map(([p, n]) => ["driver", p, n] as [string, string, string]),
    ...Object.entries(identities.requestors).map(([p, n]) => ["requestor", p, n] as [string, string, string]),
  ];

  const changes: { phone: string; from: string; to: string }[] = [];
  const missing: string[] = [];

  for (const [, phone, name] of wanted) {
    const user = await prisma.user.findUnique({ where: { phone }, select: { name: true } });
    if (!user) {
      missing.push(phone);
      continue;
    }
    if (user.name !== name) changes.push({ phone, from: user.name, to: name });
  }

  // ⚠ SAY WHICH NOTHING IT IS. "every name already matches" and "none of those
  // accounts exist here" both produce an empty change list, and only one of
  // them means the job is done.
  console.log(`Checked ${wanted.length} canonical identities against this database.`);
  console.log(`  present : ${wanted.length - missing.length}`);
  console.log(`  missing : ${missing.length}${missing.length ? ` (${missing.join(", ")})` : ""}`);
  console.log(`  to fix  : ${changes.length}\n`);

  if (missing.length === wanted.length) {
    console.error("REFUSING: not one canonical account exists here. This is not the seeded demo.");
    process.exit(3);
  }

  if (changes.length === 0) {
    console.log("Every present account already matches the canonical name. Nothing to do.");
    return;
  }
  for (const c of changes) console.log(`  ${c.phone}  "${c.from}"  ->  "${c.to}"`);

  if (!APPLY) {
    console.log(`\nPLAN ONLY — nothing written. Re-run with --apply.`);
    return;
  }

  for (const c of changes) {
    await prisma.user.update({ where: { phone: c.phone }, data: { name: c.to } });
  }

  // Verify by re-reading, not by trusting the writes.
  const after: string[] = [];
  for (const c of changes) {
    const u = await prisma.user.findUnique({ where: { phone: c.phone }, select: { name: true } });
    if (u?.name !== c.to) after.push(`${c.phone} is "${u?.name}", expected "${c.to}"`);
  }
  console.log(`\n=== APPLIED ===\n  updated: ${changes.length}`);
  console.log(`  verified: ${after.length === 0 ? "all match" : after.join("; ")}`);
  if (after.length) process.exit(5);
}

main()
  .catch((e) => {
    console.error("FAILED:", String(e.message).split("\n")[0]);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
