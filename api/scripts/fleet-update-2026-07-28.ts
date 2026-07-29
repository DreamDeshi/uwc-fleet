/**
 * PROD MIGRATION — the 28 Jul 2026 fleet revision (applied with the corrected
 * values from Mr. Teh's 29 Jul R3 answers).
 *
 * What it does, in one transaction after the guards pass:
 *   1. Ensures the "Store" department (the two new interplant drivers' dept).
 *   2. Creates the two NEW trucks (skip if already present):
 *        PSA 5292 — 10t-30ft, 14 pallets, weekday RM11 (NOT the workbook's 13:
 *                   R3 A5 "Sorry My mistake, it is RM 11 for weekday"),
 *                   off-peak RM13, deduction 2, customer/supplier.
 *        PPE 2406 — 5t-17.5ft (NOT "(10t-30ft)": R3 A6), 8 pallets, interplant
 *                   rates RM5/RM7 (the only rates the client gave it),
 *                   deduction 0 (R3 A4 "Interplant no need deduction").
 *   3. Moves the four drivers (matched by their CURRENT assigned plate, so it
 *      works whether prod carries real or synthetic identities):
 *        PLX 2406 → PND 1888   (Azmi — the A1/A2 primary follows him)
 *        PND 1888 → PSA 5292   (Shahar)
 *        PQL 5292 → PPE 1804   (Fitri)
 *        PPE 1804 → PQL 5292   (Zulkhairi)
 *      All four are nulled first — assigned_truck_plate is UNIQUE and two of
 *      the moves are a swap, so sequential updates would collide.
 *   4. Re-points truck priority_zones (driver coverage moves with the driver):
 *        PND → A1,A2,P1,P2 · PSA → P1,P2,P3,K1,K2 · PLX → [] (interplant).
 *   5. Renames zone P2 to "Juru & Perai & Batu Kawan" (workbook relabel).
 *   6. Audit-logs every step.
 *
 * What it deliberately does NOT do:
 *   - No STORE driver accounts. Their PHONE NUMBERS are unknown (the workbook
 *     has names + employee numbers only) and an account that can never log in
 *     is worse than none. PLX 2406 and PPE 2406 are left DRIVERLESS — a
 *     driverless truck is never auto-dispatched, and both are interplant-gated
 *     besides. Create the accounts when the phones arrive (R4 list).
 *   - No interplant rate table / round-trip scoring — that is money+schema
 *     work, shipping separately.
 *
 * GUARDS: refuses to run if ANY of the four moving trucks (or their drivers)
 * has an in_progress trip — a mid-run driver must not have his truck reassigned
 * under him. `assigned` (not yet started) trips are listed as WARNINGS only:
 * their pay is protected by the assignment-time rate snapshots, but the admin
 * should re-check the pairing afterwards.
 *
 * USAGE (dry-run by default; nothing writes without --apply):
 *   railway variables --service Postgres → set DATABASE_URL, then
 *   npx tsx scripts/fleet-update-2026-07-28.ts           # dry run, prints the plan
 *   npx tsx scripts/fleet-update-2026-07-28.ts --apply   # executes
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const MOVES: { from: string; to: string }[] = [
  { from: "PLX 2406", to: "PND 1888" },
  { from: "PND 1888", to: "PSA 5292" },
  { from: "PQL 5292", to: "PPE 1804" },
  { from: "PPE 1804", to: "PQL 5292" },
];

const NEW_TRUCKS = [
  {
    plate: "PSA 5292",
    type: "10t-30ft",
    max_pallets: 14,
    entitled_claim_weekday: 11, // R3 A5 — the workbook's 13 was his typo
    entitled_claim_offpeak: 13,
    daily_deduction_points: 2,
    priority_zones: ["P1", "P2", "P3", "K1", "K2"],
  },
  {
    plate: "PPE 2406",
    type: "5t-17.5ft", // R3 A6 — the workbook's "(10t-30ft)" was his typo
    max_pallets: 8,
    entitled_claim_weekday: 5, // interplant rates — the only rates it has
    entitled_claim_offpeak: 7,
    daily_deduction_points: 0, // R3 A4 — interplant has no deduction
    priority_zones: [] as string[],
  },
];

const ZONE_UPDATES: Record<string, string[]> = {
  "PND 1888": ["A1", "A2", "P1", "P2"],
  "PSA 5292": ["P1", "P2", "P3", "K1", "K2"],
  "PLX 2406": [],
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"} · DB host: ${url.replace(/.*@/, "").replace(/:\d+.*/, "") || "(unset)"}`);
  if (!url) throw new Error("DATABASE_URL is not set.");

  // ── Pre-state + guards ─────────────────────────────────────────────────────
  const movingPlates = [...new Set(MOVES.flatMap((m) => [m.from, m.to]))];
  const inProgress = await prisma.trip.findMany({
    where: { status: "in_progress", truck_plate: { in: movingPlates } },
    select: { ticket_number: true, truck_plate: true },
  });
  if (inProgress.length > 0) {
    console.error("REFUSING: in_progress trips on moving trucks:", inProgress);
    process.exitCode = 1;
    return;
  }
  const assigned = await prisma.trip.findMany({
    where: { status: "assigned", truck_plate: { in: movingPlates } },
    select: { ticket_number: true, truck_plate: true, pickup_datetime: true },
  });
  if (assigned.length > 0) {
    console.warn("⚠ WARNING — assigned (not started) trips on moving trucks; pay is snapshot-protected, but re-check these pairings after the migration:");
    for (const t of assigned) console.warn(`   ${t.ticket_number} on ${t.truck_plate} (pickup ${t.pickup_datetime.toISOString()})`);
  }

  const drivers = new Map<string, { id: string; name: string }>();
  for (const m of MOVES) {
    const u = await prisma.user.findFirst({
      where: { assigned_truck_plate: m.from, role: "driver" },
      select: { id: true, name: true },
    });
    if (!u) {
      console.error(`REFUSING: no driver currently assigned to ${m.from} — pre-state does not match the plan.`);
      process.exitCode = 1;
      return;
    }
    drivers.set(m.from, u);
    console.log(`plan: ${u.name} — ${m.from} → ${m.to}`);
  }
  for (const t of NEW_TRUCKS) {
    const exists = await prisma.truck.findUnique({ where: { plate: t.plate } });
    console.log(`plan: ${exists ? "SKIP (exists)" : "create"} truck ${t.plate} (${t.type}, ${t.max_pallets} pallets, RM${t.entitled_claim_weekday}/${t.entitled_claim_offpeak}, ded ${t.daily_deduction_points})`);
  }
  console.log(`plan: zone P2 name → "Juru & Perai & Batu Kawan" · ensure department "Store"`);
  console.log(`plan: NO STORE driver accounts (phones unknown — R4); PLX 2406 + PPE 2406 stay driverless`);

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to execute.");
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  const admin = await prisma.user.findFirst({ where: { role: "admin", status: "active" }, select: { id: true } });
  const audit = (action: string, record_id: string) =>
    admin
      ? { user_id: admin.id, action, table_name: "FleetUpdate", record_id }
      : null;

  // ⚠ EXPLICIT TIMEOUTS. Prisma's interactive transaction defaults to a 5s
  // budget; this body issues ~15 sequential statements and, run from a laptop
  // against the Railway PUBLIC proxy, each round-trip costs enough that the
  // default expires mid-way. The first real attempt (29 Jul 2026) died on
  // P2028 "Transaction not found" — it rolled back cleanly, but a migration
  // whose success depends on network latency is a trap for the next person.
  await prisma.$transaction(
    async (tx) => {
      await tx.department.upsert({ where: { name: "Store" }, update: {}, create: { name: "Store" } });

      for (const t of NEW_TRUCKS) {
        const exists = await tx.truck.findUnique({ where: { plate: t.plate } });
        if (!exists) await tx.truck.create({ data: t });
      }

      // Null the movers first (unique FK + a swap), then set the new pairs.
      for (const m of MOVES) {
        await tx.user.update({ where: { id: drivers.get(m.from)!.id }, data: { assigned_truck_plate: null } });
      }
      for (const m of MOVES) {
        await tx.user.update({ where: { id: drivers.get(m.from)!.id }, data: { assigned_truck_plate: m.to } });
        const a = audit(`fleet.driver_moved:${m.from}->${m.to}`, drivers.get(m.from)!.id);
        if (a) await tx.auditLog.create({ data: a });
      }

      for (const [plate, zones] of Object.entries(ZONE_UPDATES)) {
        await tx.truck.update({ where: { plate }, data: { priority_zones: zones } });
      }

      await tx.zone.update({ where: { code: "P2" }, data: { name: "Juru & Perai & Batu Kawan" } });
      const a = audit("fleet.revision_2026_07_28_applied", "P2");
      if (a) await tx.auditLog.create({ data: a });
    },
    { timeout: 120_000, maxWait: 30_000 }
  );

  console.log("\n✔ Fleet revision applied.");
  for (const m of MOVES) console.log(`  ${drivers.get(m.from)!.name}: ${m.from} → ${m.to}`);
}

main()
  .catch((e) => {
    console.error("MIGRATION FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
