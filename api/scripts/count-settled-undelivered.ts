/**
 * READ-ONLY prod count — the pre-merge gate on PR #40 (failed-delivery pay).
 *
 * PR #40 pays a stop that is (1) not delivered, (2) has arrived_at set, and
 * (3) has a stop-attached exception that is `resolved` + `resolution: "resume"`
 * + carries a `verify` action.
 *
 * FEATURE_EXCEPTIONS gates the exception ROUTER, not that predicate. So while
 * the flag being off means no NEW exception can be reported, any PRE-EXISTING
 * row already matching (1)+(2)+(3) would become payable the moment #40 deploys,
 * flag or no flag. The dg-t7 trial ran with the flag on at least once, so this
 * has to be counted rather than assumed.
 *
 * Writes NOTHING. No transaction, no updates — every query below is a read.
 *
 * USAGE (DATABASE_URL piped in from Railway, never printed):
 *   npx tsx scripts/count-settled-undelivered.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// The exact predicate from api/src/services/undeliveredPay.ts on the PR #40
// branch. Kept literal here rather than imported, because this script must run
// against MAIN (which has no such module) to describe what a #40 deploy meets.
const SETTLED_UNDELIVERED_WHERE = {
  status: { not: "delivered" as const },
  arrived_at: { not: null },
  exceptions: {
    some: {
      current_state: "resolved" as const,
      resolution: "resume" as const,
      actions: { some: { type: "verify" as const } },
    },
  },
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL is not set.");
  // Host only — never the credential.
  console.log(`DB host: ${url.replace(/.*@/, "").replace(/[:/].*/, "")}`);

  const totalExceptions = await prisma.tripException.count();
  console.log(`\nTripException rows on prod: ${totalExceptions}`);
  if (totalExceptions === 0) {
    console.log("→ No exception has ever been reported. Nothing can match. GATE CLEAR.");
    return;
  }

  // Widen to narrow: each condition in turn, so a non-zero count is diagnosable.
  const resolved = await prisma.tripException.count({ where: { current_state: "resolved" } });
  const resumed = await prisma.tripException.count({
    where: { current_state: "resolved", resolution: "resume" },
  });
  const verifiedAndResumed = await prisma.tripException.count({
    where: {
      current_state: "resolved",
      resolution: "resume",
      actions: { some: { type: "verify" } },
    },
  });
  const stopAttached = await prisma.tripException.count({
    where: {
      current_state: "resolved",
      resolution: "resume",
      actions: { some: { type: "verify" } },
      trip_stop_id: { not: null },
    },
  });

  console.log(`  ├─ current_state = resolved:                 ${resolved}`);
  console.log(`  ├─ ... AND resolution = resume:              ${resumed}`);
  console.log(`  ├─ ... AND has a verify action:              ${verifiedAndResumed}`);
  console.log(`  └─ ... AND attached to a stop (not trip):    ${stopAttached}`);

  // THE NUMBER: stops that would become payable.
  const payable = await prisma.tripStop.findMany({
    where: SETTLED_UNDELIVERED_WHERE,
    select: {
      id: true,
      status: true,
      arrived_at: true,
      zone_code: true,
      points_awarded: true,
      consignee: { select: { company_name: true, zone_code: true } },
      trip: {
        select: {
          ticket_number: true,
          status: true,
          incentive_earned: true,
          incentive_final: true,
          driver: { select: { name: true } },
        },
      },
    },
  });

  console.log(`\n=== STOPS THAT WOULD BECOME PAYABLE: ${payable.length} ===`);
  for (const s of payable) {
    console.log(
      `  ${s.trip.ticket_number} · ${s.trip.status} · ${s.consignee.company_name} ` +
        `(${s.consignee.zone_code}) · stop=${s.status} · arrived=${s.arrived_at?.toISOString()} ` +
        `· driver=${s.trip.driver?.name ?? "—"} · already_scored=${s.points_awarded ?? "no"} ` +
        `· trip_incentive=${s.trip.incentive_earned ?? "null"}/${s.trip.incentive_final ?? "null"}`
    );
  }

  // A trip that ALREADY finalized cannot be re-scored (incentive_earned is
  // write-once), so those are inert even if a stop matches. The live risk is
  // trips still in_progress that would newly finalize or score differently.
  const liveRisk = payable.filter((s) => s.trip.status === "in_progress");
  console.log(`\nOf those, on trips still in_progress (the live risk): ${liveRisk.length}`);
  console.log(
    payable.length === 0
      ? "→ GATE CLEAR: no pre-existing row matches. Deploying #40 changes no existing money."
      : "→ REVIEW EACH ROW ABOVE before merging #40."
  );
}

main()
  .catch((e) => {
    console.error("COUNT FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
