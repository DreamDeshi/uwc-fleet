/**
 * Demo data for the A4 presentation.
 *
 *  1. Removes the junk test bookings (consignees "Among us" / "Yyy") and the
 *     junk consignees themselves.
 *  2. Wipes the demo driver's existing trips + any leftover demo pending trip,
 *     then recreates a clean, professional-looking set:
 *       - a full week of completed deliveries (drives the earnings page + chart)
 *       - one in-progress trip with a fresh GPS fix (live map demo)
 *       - one assigned trip ready to "Start" (driver flow demo)
 *       - one pending trip with no driver (admin dispatch demo)
 *
 * Idempotent: safe to re-run. Run with:
 *   npx tsx prisma/seed-demo-trips.ts   (from the api/ workspace)
 */
import { prisma } from "../src/lib/prisma";

const JUNK_NAMES = ["Among us", "Yyy"];
const DEMO_DRIVER_PHONE = "+60100000101"; // Mohd Azmi B. Che Dol — truck PLX 2406
const TANK = "PLX 2406";

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

  // Make the requestor look real for the dashboard demo (name + department).
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

  // One good consignee per zone we deliver to (prefer ones with a phone number
  // so the driver's tap-to-call button has something to dial).
  const zonesNeeded = ["A2", "K1", "P1", "K2", "P2", "P3"];
  const consigneeByZone: Record<string, { id: string; zone_code: string }> = {};
  for (const z of zonesNeeded) {
    const withPhone = await prisma.consignee.findFirst({
      where: { zone_code: z, phone: { not: null }, company_name: { notIn: JUNK_NAMES } },
      orderBy: { company_name: "asc" },
    });
    const any = withPhone ?? (await prisma.consignee.findFirst({
      where: { zone_code: z, company_name: { notIn: JUNK_NAMES } },
      orderBy: { company_name: "asc" },
    }));
    if (any) consigneeByZone[z] = { id: any.id, zone_code: any.zone_code };
  }
  const pickZone = (z: string) => consigneeByZone[z] ?? consigneeByZone["P2"];

  // ── 1. Remove junk bookings + consignees ────────────────────────────────
  const junkTrips = await prisma.trip.findMany({
    where: { stops: { some: { consignee: { company_name: { in: JUNK_NAMES } } } } },
    select: { id: true },
  });
  await deleteTripsByIds(junkTrips.map((t) => t.id));
  await prisma.consignee.deleteMany({ where: { company_name: { in: JUNK_NAMES } } });
  console.log(`Removed ${junkTrips.length} junk trip(s) and junk consignees.`);

  // ── 2. Clear prior demo trips (idempotent) ──────────────────────────────
  const oldDriverTrips = await prisma.trip.findMany({ where: { driver_id: driver.id }, select: { id: true } });
  await deleteTripsByIds(oldDriverTrips.map((t) => t.id));
  const oldPending = await prisma.trip.findMany({
    where: { requestor_id: requestor.id, driver_id: null, status: "pending" },
    select: { id: true },
  });
  await deleteTripsByIds(oldPending.map((t) => t.id));
  console.log(`Cleared ${oldDriverTrips.length} prior driver trip(s) + ${oldPending.length} pending.`);

  // ── 3. Build the demo week ──────────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const at = (daysFromToday: number, hour: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + daysFromToday);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  type Spec = {
    offset: number; hour: number; zone: string; route: string;
    pallets: number; size: string; amount: number | null;
    status: "completed" | "in_progress" | "assigned" | "pending";
    withDriver: boolean;
  };

  const completed = (offset: number, hour: number, zone: string, route: string, pallets: number, size: string, amount: number): Spec =>
    ({ offset, hour, zone, route, pallets, size, amount, status: "completed", withDriver: true });

  const specs: Spec[] = [
    // This week — Mon 22 .. Wed 24 (today), two deliveries a day.
    completed(-2, 9, "A2", "Customer Delivery", 6, "4×8", 88),
    completed(-2, 14, "P2", "Supplier Delivery", 4, "4×4", 22),
    completed(-1, 8, "K1", "Customer Delivery", 5, "3×4", 44),
    completed(-1, 15, "P1", "Customer Delivery", 8, "4×4", 55),
    completed(0, 8, "K2", "Inter-Plant Delivery", 10, "4×8", 66),
    completed(0, 11, "P3", "Supplier Delivery", 3, "2×2", 39),
    // Last week — adds depth to the breakdown list + monthly totals.
    completed(-7, 9, "A2", "Customer Delivery", 6, "4×8", 80),
    completed(-6, 10, "K1", "Supplier Delivery", 4, "3×4", 45),
    completed(-5, 13, "P1", "Customer Delivery", 7, "4×4", 60),
    // Live + flow demos.
    { offset: 0, hour: 16, zone: "K1", route: "Customer Delivery", pallets: 6, size: "4×4", amount: null, status: "in_progress", withDriver: true },
    { offset: 1, hour: 9, zone: "P1", route: "Customer Delivery", pallets: 5, size: "3×4", amount: null, status: "assigned", withDriver: true },
    { offset: 1, hour: 11, zone: "P3", route: "Supplier Delivery", pallets: 4, size: "4×4", amount: null, status: "pending", withDriver: false },
  ];

  // Per-date ticket counter for realistic, unique TKT-YYYYMMDD-NNN numbers.
  const seqByDate: Record<string, number> = {};
  const nextTicket = (d: Date) => {
    const key = ymd(d);
    seqByDate[key] = (seqByDate[key] ?? 800) + 1;
    return `TKT-${key}-${seqByDate[key]}`;
  };

  let inProgressTripId: string | null = null;

  for (const s of specs) {
    const when = at(s.offset, s.hour);
    const c = pickZone(s.zone);
    const isK2 = c.zone_code === "K2";

    const stopStatus = s.status === "completed" ? "delivered" : s.status === "in_progress" ? "arrived" : "pending";
    const trip = await prisma.trip.create({
      data: {
        ticket_number: nextTicket(when),
        requestor_id: requestor.id,
        driver_id: s.withDriver ? driver.id : null,
        truck_plate: s.withDriver ? TANK : null,
        route_type_id: routeId(s.route),
        status: s.status,
        pickup_datetime: when,
        incentive_earned: s.amount != null ? s.amount.toFixed(2) : null,
        stops: {
          create: [{
            sequence: 1,
            consignee_id: c.id,
            status: stopStatus,
            arrived_at: stopStatus === "delivered" || stopStatus === "arrived" ? new Date(when.getTime() + 60 * 60 * 1000) : null,
            delivered_at: stopStatus === "delivered" ? new Date(when.getTime() + 2 * 60 * 60 * 1000) : null,
            do_uploaded: stopStatus === "delivered",
            k2_form_ack: stopStatus === "delivered" && isK2,
          }],
        },
        cargo_details: { create: [{ pallet_type: s.size, quantity: s.pallets }] },
      },
    });
    if (s.status === "in_progress") inProgressTripId = trip.id;
  }

  // Fresh GPS fix for the in-progress trip so the live map shows the truck
  // en route (not "stale"). A point roughly between the plant and Kulim.
  if (inProgressTripId) {
    await prisma.locationLog.create({
      data: {
        trip_id: inProgressTripId,
        driver_id: driver.id,
        latitude: "5.4200000",
        longitude: "100.5000000",
        recorded_at: new Date(),
      },
    });
  }

  console.log(`Created ${specs.length} demo trips (${specs.filter((s) => s.status === "completed").length} completed).`);
  console.log("Demo data ready for the presentation.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
