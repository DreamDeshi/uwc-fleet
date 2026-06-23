/**
 * Seeds the database with everything Phase 1 needs to test auth end-to-end
 * and everything later phases will need to test trips/incentives:
 *   - 15 departments
 *   - 7 zones + destination point rates + adjacency
 *   - 6 route types
 *   - 7 trucks (real plates/rates from the Development Brief Section 2)
 *   - 6 drivers (real names, employee numbers, truck assignments)
 *   - 1 bootstrap admin account
 *   - All real consignees from the UWC Excel ("CONSIGNEE and CONSIGNOR" sheet)
 *
 * Run with: npm run seed --workspace=api
 */
import path from "path";
import bcrypt from "bcrypt";
import * as xlsx from "xlsx";
import { prisma } from "../src/lib/prisma";

const BCRYPT_COST = 10;
const SEED_PASSWORD = "Password123"; // placeholder — change after first login

// Driver phone numbers are not in the brief; these are placeholders for
// testing only. Replace with real numbers once UWC provides them.
const DRIVERS = [
  {
    name: "Mohd Azmi B. Che Dol",
    employee_number: "H593",
    phone: "+60100000101",
    truck_plate: "PLX 2406",
    priority_zones: ["A1", "A2", "P1", "P2"],
  },
  {
    name: "Mohd Shahar B. Abdul Razak",
    employee_number: "H3428",
    phone: "+60100000102",
    truck_plate: "PND 1888",
    // ALL except A1 & A2 — assign A1/A2 only if PLX2406 unavailable (dispatch-time rule, not stored here)
    priority_zones: ["P1", "P2", "P3", "K1", "K2"],
  },
  {
    name: "Amirudin Hj Abu Bakar",
    employee_number: "H3158",
    phone: "+60100000103",
    truck_plate: "PRJ 5292",
    priority_zones: ["P1", "P2", "P3", "K1", "K2"],
  },
  {
    name: "Mohamad Fitri B. Yahya",
    employee_number: "CW022",
    phone: "+60100000104",
    truck_plate: "PQL 5292",
    priority_zones: ["P1", "P2", "P3", "K1", "K2"],
  },
  {
    name: "Muhamad Zulkhairi Bin Yusuf",
    employee_number: "H5359",
    phone: "+60100000105",
    truck_plate: "PPE 1804",
    priority_zones: ["P1", "P2", "P3", "K1", "K2"],
  },
  {
    name: "Khoo Jie Yie",
    employee_number: "H5158",
    phone: "+60100000106",
    truck_plate: "PRH 5292",
    // ALL zones — A1/A2 only if <2 pallets of 4x4 (dispatch-time rule, not stored here)
    priority_zones: ["P1", "P2", "P3", "K1", "K2", "A1", "A2"],
  },
];

const TRUCKS = [
  { plate: "PLX 2406", type: "10t 30ft", max_pallets: 16, weekday: "11", offpeak: "13", deduction: 2 },
  { plate: "PND 1888", type: "10t 30ft", max_pallets: 14, weekday: "11", offpeak: "13", deduction: 2 },
  { plate: "PRJ 5292", type: "5t 17.5ft", max_pallets: 8, weekday: "10", offpeak: "10", deduction: 3 },
  { plate: "PQL 5292", type: "5t 17.5ft", max_pallets: 8, weekday: "10", offpeak: "10", deduction: 3 },
  { plate: "PPE 1804", type: "5t 17.5ft", max_pallets: 8, weekday: "10", offpeak: "12", deduction: 3 },
  { plate: "PRH 5292", type: "1t", max_pallets: 2, weekday: "9", offpeak: "9", deduction: 2 },
  { plate: "4 Wheel", type: "Generic", max_pallets: 2, weekday: "11", offpeak: "11", deduction: 2 }, // TODO: real plate unknown, confirm with UWC
];

const DEPARTMENTS = [
  "Sheet Metal", "Assembly", "Painting", "Machining", "Warehouse",
  "Quality Assurance", "Product Development", "Human Resources", "Marketing",
  "Maintenance", "Industrial Engineering", "Info Technology", "Planning",
  "Purchasing", "Finance",
];

const ZONES = [
  { code: "P1", name: "Penang Island" },
  { code: "P2", name: "Juru & Perai (SPS, SPT)" },
  { code: "P3", name: "Tasek Gelugor (SPU)" },
  { code: "K1", name: "Kulim" },
  { code: "K2", name: "Sungai Petani / Kuala Ketil" },
  { code: "A1", name: "Taiping" },
  { code: "A2", name: "Ipoh" },
];

// Section 2 destination points table — first-trip-of-day points per destination
const DESTINATION_RATES = [
  { zone_code: "P2", location_name: "Juru & Perai (SPS, SPT)", points: 1 },
  { zone_code: "K1", location_name: "Kulim", points: 3 },
  { zone_code: "P1", location_name: "Penang Island", points: 3 },
  { zone_code: "P3", location_name: "Tasek Gelugor (SPU)", points: 3 },
  { zone_code: "K2", location_name: "Kuala Ketil", points: 4 },
  { zone_code: "K2", location_name: "Sungai Petani", points: 4 },
  { zone_code: "A1", location_name: "Taiping", points: 5 },
  { zone_code: "A2", location_name: "Ipoh", points: 6 },
  { zone_code: null, location_name: "Kuala Lumpur", points: 8 },
];

// Zone adjacency rules from Mr. Teh's email (Section 4)
const ZONE_ADJACENCY: [string, string][] = [
  ["P2", "K1"], // P2 and K1 are adjacent
  ["P2", "A1"], // P2 -> A2 route passes through A1
];

const ROUTE_TYPES = [
  "Customer Delivery",
  "Supplier Delivery",
  "Inter-Plant Delivery",
  "Customer Return",
  "Supplier Return",
  "Inter-Plant Return",
];

async function seedDepartments() {
  for (const name of DEPARTMENTS) {
    await prisma.department.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log(`Seeded ${DEPARTMENTS.length} departments.`);
}

async function seedZones() {
  for (const zone of ZONES) {
    await prisma.zone.upsert({ where: { code: zone.code }, update: { name: zone.name }, create: zone });
  }
  for (const rate of DESTINATION_RATES) {
    const exists = await prisma.destinationRate.findFirst({
      where: { location_name: rate.location_name },
    });
    if (!exists) {
      await prisma.destinationRate.create({ data: rate });
    }
  }
  for (const [a, b] of ZONE_ADJACENCY) {
    await prisma.zone.update({
      where: { code: a },
      data: { adjacentTo: { connect: { code: b } } },
    });
    await prisma.zone.update({
      where: { code: b },
      data: { adjacentTo: { connect: { code: a } } },
    });
  }
  console.log(`Seeded ${ZONES.length} zones, ${DESTINATION_RATES.length} destination rates, ${ZONE_ADJACENCY.length} adjacency pairs.`);
}

async function seedRouteTypes() {
  for (const name of ROUTE_TYPES) {
    await prisma.routeType.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log(`Seeded ${ROUTE_TYPES.length} route types.`);
}

async function seedTrucks() {
  for (const t of TRUCKS) {
    await prisma.truck.upsert({
      where: { plate: t.plate },
      update: {},
      create: {
        plate: t.plate,
        type: t.type,
        max_pallets: t.max_pallets,
        entitled_claim_weekday: t.weekday,
        entitled_claim_offpeak: t.offpeak,
        daily_deduction_points: t.deduction,
        priority_zones: [],
      },
    });
  }
  console.log(`Seeded ${TRUCKS.length} trucks.`);
}

async function seedDrivers() {
  for (const d of DRIVERS) {
    const password_hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);
    await prisma.user.upsert({
      where: { phone: d.phone },
      update: {},
      create: {
        phone: d.phone,
        password_hash,
        name: d.name,
        employee_number: d.employee_number,
        role: "driver",
        status: "active",
        assigned_truck_plate: d.truck_plate,
      },
    });
    await prisma.truck.update({
      where: { plate: d.truck_plate },
      data: { priority_zones: d.priority_zones },
    });
  }
  console.log(`Seeded ${DRIVERS.length} drivers (password: ${SEED_PASSWORD}).`);
}

async function seedAdmin() {
  const password_hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);
  await prisma.user.upsert({
    where: { phone: "+60100000001" },
    update: {},
    create: {
      phone: "+60100000001",
      password_hash,
      name: "UWC Admin",
      role: "admin",
      status: "active",
    },
  });
  console.log(`Seeded bootstrap admin (+60100000001 / ${SEED_PASSWORD}).`);
}

async function seedConsignees() {
  const excelPath = path.resolve(__dirname, "../../References/TRUCK BOOKING SYSTEM (YS).xlsx");
  const workbook = xlsx.readFile(excelPath);
  const sheet = workbook.Sheets["CONSIGNEE and CONSIGNOR "];
  if (!sheet) {
    console.warn('Sheet "CONSIGNEE and CONSIGNOR" not found — skipping consignee seed.');
    return;
  }

  const rows: any[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const dataRows = rows.slice(1); // skip header row

  let inserted = 0;
  let skipped = 0;

  for (const row of dataRows) {
    const company_name = String(row[0] ?? "").trim();
    if (!company_name) {
      skipped++;
      continue;
    }

    const zone_code = String(row[9] ?? "").trim();
    if (!zone_code) {
      skipped++;
      continue;
    }

    await prisma.consignee.create({
      data: {
        company_name,
        vendor_code: String(row[1] ?? "").trim() || null,
        contact_person: String(row[2] ?? "").trim() || null,
        phone: String(row[3] ?? "").trim() || null,
        address_1: String(row[4] ?? "").trim() || null,
        address_2: String(row[5] ?? "").trim() || null,
        area: String(row[6] ?? "").trim() || null,
        state: String(row[7] ?? "").trim() || null,
        zone_code,
        postal_code: String(row[10] ?? "").trim() || null,
      },
    });
    inserted++;
  }

  console.log(`Seeded ${inserted} consignees from Excel (skipped ${skipped} rows with no company name or zone).`);
}

async function main() {
  await seedDepartments();
  await seedZones();
  await seedRouteTypes();
  await seedTrucks();
  await seedDrivers();
  await seedAdmin();

  const existingConsignees = await prisma.consignee.count();
  if (existingConsignees === 0) {
    await seedConsignees();
  } else {
    console.log(`Consignees already seeded (${existingConsignees} rows) — skipping Excel import.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
