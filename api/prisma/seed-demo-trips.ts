/**
 * Clean demo data for the final review (Phase 9).
 *
 * Wipes ALL existing trips and the junk self-added consignees, then creates
 * exactly 5 professional-looking demo trips — one of each lifecycle state —
 * all owned by a realistically-named requestor ("Tan Wei Ming"):
 *   1. pending       — just submitted, no driver yet (admin dispatch demo)
 *   2. assigned      — driver assigned, not started (driver "Start Trip" demo)
 *   3. in_progress   — driver en route, with a fresh GPS fix (live-map demo)
 *   4. completed     — delivered, incentive calculated (earnings demo)
 *   5. rejected      — with an admin reason shown to the requestor
 *
 * All consignees are real companies from the seeded UWC list (no fake names).
 * Idempotent: safe to re-run. Run with:
 *   npx tsx prisma/seed-demo-trips.ts   (from the api/ workspace)
 */
import { prisma } from "../src/lib/prisma";

const DEMO_DRIVER_PHONE = "+60100000101"; // Mohd Azmi B. Che Dol — truck PLX 2406
const TRUCK = "PLX 2406";

// Self-added test consignees to purge (created_by set, obviously not real).
const JUNK_CONSIGNEES = ["Among us", "Yyy", "Congolese", "Hahah", "Chemor"];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

async function deleteTripsByIds(ids: string[]) {
  if (ids.length === 0) return;
  await prisma.locationLog.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.tripDocument.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.externalForwarder.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.cargoDetail.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.tripStop.deleteMany({ where: { trip_id: { in: ids } } });
  await prisma.trip.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  // ── References ────────────────────────────────────────────────────────
  const driver = await prisma.user.findUnique({ where: { phone: DEMO_DRIVER_PHONE } });
  if (!driver) throw new Error(`Demo driver ${DEMO_DRIVER_PHONE} not found — run the main seed first.`);

  let requestor = await prisma.user.findFirst({ where: { role: "requestor" }, orderBy: { created_at: "asc" } });
  if (!requestor) throw new Error("No requestor found — register one in the app first.");

  // Make the requestor look real for the demo (name + department).
  const warehouse = await prisma.department.findUnique({ where: { name: "Warehouse" } });
  requestor = await prisma.user.update({
    where: { id: requestor.id },
    data: { name: "Tan Wei Ming", department_id: warehouse?.id ?? undefined },
  });

  const routeTypes = await prisma.routeType.findMany();
  const routeId = (name: string) => {
    const rt = routeTypes.find((r) => r.name === name);
    if (!rt) throw new Error(`Route type "${name}" not found.`);
    return rt.id;
  };

  // Pick one real consignee per zone (prefer one with a phone so the driver's
  // tap-to-call button has something to dial).
  const pickConsignee = async (zone: string) => {
    const withPhone = await prisma.consignee.findFirst({
      where: { zone_code: zone, phone: { not: null }, company_name: { notIn: JUNK_CONSIGNEES } },
      orderBy: { company_name: "asc" },
    });
    const c = withPhone ?? (await prisma.consignee.findFirst({
      where: { zone_code: zone, company_name: { notIn: JUNK_CONSIGNEES } },
      orderBy: { company_name: "asc" },
    }));
    if (!c) throw new Error(`No clean consignee found in zone ${zone}.`);
    return c;
  };

  // ── 1. Clean slate: remove every trip + junk consignees ─────────────────
  const allTrips = await prisma.trip.findMany({ select: { id: true } });
  await deleteTripsByIds(allTrips.map((t) => t.id));
  const junk = await prisma.consignee.deleteMany({ where: { company_name: { in: JUNK_CONSIGNEES } } });
  console.log(`Cleared ${allTrips.length} existing trip(s) and ${junk.count} junk consignee(s).`);

  // ── 2. Build the 5 demo trips ───────────────────────────────────────────
  const now = new Date();
  const at = (daysFromNow: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  const seqByDate: Record<string, number> = {};
  const nextTicket = (d: Date) => {
    const key = ymd(d);
    seqByDate[key] = (seqByDate[key] ?? 100) + 1;
    return `TKT-${key}-${seqByDate[key]}`;
  };

  type Spec = {
    when: Date;
    zone: string;
    route: string;
    pallets: number;
    size: string;
    status: "pending" | "assigned" | "in_progress" | "completed" | "rejected";
    withDriver: boolean;
    incentive?: number;
    rejectionReason?: string;
  };

  const specs: Spec[] = [
    // 1. Pending — submitted this morning, awaiting admin dispatch.
    { when: at(0, 9), zone: "P1", route: "Customer Delivery", pallets: 6, size: "4×4", status: "pending", withDriver: false },
    // 2. Assigned — driver assigned for this afternoon, not yet started.
    { when: at(0, 14), zone: "K1", route: "Supplier Delivery", pallets: 5, size: "3×4", status: "assigned", withDriver: true },
    // 3. In progress — driver currently en route (live map demo).
    { when: at(0, 8), zone: "P2", route: "Inter-Plant Delivery", pallets: 8, size: "4×4", status: "in_progress", withDriver: true },
    // 4. Completed — delivered yesterday, first trip of the day to Ipoh (A2):
    //    6 pts − 2 (PLX 2406 deduction) = 4 pts × RM 11 weekday = RM 44.
    { when: at(-1, 9), zone: "A2", route: "Customer Delivery", pallets: 10, size: "4×8", status: "completed", withDriver: true, incentive: 44 },
    // 5. Rejected — with a clear admin reason.
    {
      when: at(0, 16),
      zone: "K2",
      route: "Supplier Delivery",
      pallets: 12,
      size: "4×8",
      status: "rejected",
      withDriver: false,
      rejectionReason: "No 30ft truck available for this time slot. Please rebook for tomorrow morning.",
    },
  ];

  let inProgressTripId: string | null = null;

  for (const s of specs) {
    const c = await pickConsignee(s.zone);
    const isK2 = c.zone_code === "K2";
    const stopStatus =
      s.status === "completed" ? "delivered" : s.status === "in_progress" ? "arrived" : "pending";

    const trip = await prisma.trip.create({
      data: {
        ticket_number: nextTicket(s.when),
        requestor_id: requestor.id,
        driver_id: s.withDriver ? driver.id : null,
        truck_plate: s.withDriver ? TRUCK : null,
        route_type_id: routeId(s.route),
        status: s.status,
        pickup_datetime: s.when,
        incentive_earned: s.incentive != null ? s.incentive.toFixed(2) : null,
        rejection_reason: s.rejectionReason ?? null,
        stops: {
          create: [{
            sequence: 1,
            consignee_id: c.id,
            status: stopStatus,
            arrived_at: stopStatus === "delivered" || stopStatus === "arrived" ? new Date(s.when.getTime() + 60 * 60 * 1000) : null,
            delivered_at: stopStatus === "delivered" ? new Date(s.when.getTime() + 2 * 60 * 60 * 1000) : null,
            do_uploaded: stopStatus === "delivered",
            k2_form_ack: stopStatus === "delivered" && isK2,
          }],
        },
        cargo_details: { create: [{ pallet_type: s.size, quantity: s.pallets }] },
      },
    });
    if (s.status === "in_progress") inProgressTripId = trip.id;
  }

  // Fresh GPS fix for the in-progress trip so the live map shows the truck en
  // route (not "stale"). A point between the plant and the Juru/Perai area.
  if (inProgressTripId) {
    await prisma.locationLog.create({
      data: {
        trip_id: inProgressTripId,
        driver_id: driver.id,
        latitude: "5.4100000",
        longitude: "100.4200000",
        recorded_at: new Date(),
      },
    });
  }

  console.log(`Created ${specs.length} clean demo trips (pending, assigned, in_progress, completed, rejected).`);
  console.log("Demo data ready.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
