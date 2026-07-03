/**
 * Seeds the database from the authoritative spec extract (docs/uwc-spec.json)
 * plus a few seed-only test fixtures that are NOT spec data:
 *   - departments, zones, destination points, route types, trucks and driver
 *     assignments all come from docs/uwc-spec.json (single source of truth)
 *   - driver phone numbers, truck document-expiry dates and zone adjacency are
 *     test/demo fixtures defined here (the workbook doesn't carry them)
 *   - 1 bootstrap admin account
 *   - All real consignees from the UWC Excel ("CONSIGNEE and CONSIGNOR" sheet)
 *
 * To change a truck rate, a destination's points, a driver, etc., edit
 * docs/uwc-spec.json — never hardcode those values here again.
 *
 * Run with: npm run seed --workspace=api
 */
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import * as xlsx from "xlsx";
import { prisma } from "../src/lib/prisma";
import { PUBLIC_HOLIDAYS_2026 } from "../src/data/publicHolidays2026";

const BCRYPT_COST = 10;
const SEED_PASSWORD = "Password123"; // placeholder — change after first login

// ── Authoritative spec data (docs/uwc-spec.json) ───────────────────────────
interface UwcSpec {
  trucks: {
    plate: string;
    type: string;
    max_pallets: number;
    weekday_rate: number;
    offpeak_rate: number;
    daily_deduction: number;
    priority_zones: string[];
  }[];
  zones: { code: string; coverage_area: string }[];
  destination_points: { zone_code: string | null; location_name: string; points: number }[];
  route_types: string[];
  cargo: {
    cargo_types: string[];
    pallet_sizes: { size: string; factor: number }[];
    non_pallet: { type: string; factor: number; note: string }[];
  };
  departments: string[];
  driver_assignments: {
    name: string;
    employee_no: string;
    department: string;
    truck: string;
    priority_zones: string[];
    priority_zones_raw: string;
    notes: string | null;
  }[];
}

const SPEC_PATH = path.resolve(__dirname, "../../docs/uwc-spec.json");
const spec: UwcSpec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf-8"));

// PII overlay: the public docs/uwc-spec.json carries NEUTRAL placeholder driver
// names/employee numbers (the repo is public; the real identities are NDA data).
// The real values live in the gitignored References/ folder and are applied
// here, matched by truck plate, whenever the overlay file is present locally —
// so a local seed still produces the real drivers.
const PRIVATE_SPEC_PATH = path.resolve(__dirname, "../../References/uwc-spec.private.json");
if (fs.existsSync(PRIVATE_SPEC_PATH)) {
  const overlay = JSON.parse(fs.readFileSync(PRIVATE_SPEC_PATH, "utf-8")) as {
    driver_assignments: { truck: string; name: string; employee_no: string }[];
  };
  const realByTruck = new Map(overlay.driver_assignments.map((d) => [d.truck, d]));
  for (const d of spec.driver_assignments) {
    const real = realByTruck.get(d.truck);
    if (real) {
      d.name = real.name;
      d.employee_no = real.employee_no;
    }
  }
  console.log("Applied private driver-identity overlay (References/uwc-spec.private.json).");
}

// ── Seed-only test fixtures (NOT spec data) ────────────────────────────────

// Driver phone numbers are not in the spec; placeholders for testing only.
// Keyed by TRUCK PLATE — stable across the public spec and the private overlay
// (the public tree carries no real employee numbers to key on).
const DRIVER_PHONES: Record<string, string> = {
  "PLX 2406": "+60100000101",
  "PND 1888": "+60100000102",
  "PRJ 5292": "+60100000103",
  "PQL 5292": "+60100000104",
  "PPE 1804": "+60100000105",
  "PRH 5292": "+60100000106",
};

// Document-expiry dates (demo fixtures, not spec data; keyed by plate). All
// comfortably future: expired insurance/road tax now HARD-BLOCKS dispatch (and
// an expired permit warns), so near-term dates would silently sideline trucks
// mid-trial. To demo the ≤30-day expiry alerts (or the block itself), set a
// near date live via the Trucks page "Update documents" editor — reversible
// and audit-logged. (PND 1888's road tax, 2026-10-01, re-enters the alert
// window from September naturally.)
const TRUCK_EXPIRY: Record<string, { insurance: string; permit: string; roadtax: string }> = {
  "PLX 2406": { insurance: "2026-12-15", permit: "2026-11-01", roadtax: "2027-07-10" },
  "PND 1888": { insurance: "2027-07-05", permit: "2027-01-20", roadtax: "2026-10-01" },
  "PRJ 5292": { insurance: "2027-09-01", permit: "2027-07-18", roadtax: "2026-12-01" },
  "PQL 5292": { insurance: "2027-02-01", permit: "2027-01-10", roadtax: "2026-11-20" },
  "PPE 1804": { insurance: "2027-03-15", permit: "2026-12-05", roadtax: "2027-01-08" },
  "PRH 5292": { insurance: "2027-01-01", permit: "2026-12-20", roadtax: "2027-02-10" },
  "4 Wheel": { insurance: "2027-04-01", permit: "2027-03-01", roadtax: "2027-02-15" },
};

// Zone adjacency rules from Mr. Teh's email (not in the spec workbook).
const ZONE_ADJACENCY: [string, string][] = [
  ["P2", "K1"], // P2 and K1 are adjacent
  ["P2", "A1"], // P2 -> A2 route passes through A1
];

async function seedDepartments() {
  for (const name of spec.departments) {
    await prisma.department.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log(`Seeded ${spec.departments.length} departments.`);
}

async function seedZones() {
  for (const zone of spec.zones) {
    await prisma.zone.upsert({
      where: { code: zone.code },
      update: { name: zone.coverage_area },
      create: { code: zone.code, name: zone.coverage_area },
    });
  }
  for (const rate of spec.destination_points) {
    // Matched by location NAME (a zone can hold two locations — K2 is both
    // Sungai Petani and Kuala Ketil) and created only when missing, so an
    // admin's later point edits survive a re-seed.
    const exists = await prisma.destinationRate.findFirst({
      where: { location_name: rate.location_name },
    });
    if (!exists) {
      await prisma.destinationRate.create({ data: rate });
    }
  }
  for (const [a, b] of ZONE_ADJACENCY) {
    await prisma.zone.update({ where: { code: a }, data: { adjacentTo: { connect: { code: b } } } });
    await prisma.zone.update({ where: { code: b }, data: { adjacentTo: { connect: { code: a } } } });
  }
  console.log(
    `Seeded ${spec.zones.length} zones, ${spec.destination_points.length} destination rates, ${ZONE_ADJACENCY.length} adjacency pairs.`
  );
}

async function seedRouteTypes() {
  for (const name of spec.route_types) {
    await prisma.routeType.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log(`Seeded ${spec.route_types.length} route types.`);
}

async function seedTrucks() {
  // Rate provenance — Mr. Teh's authoritative INTERNAL LORRY RATE sheet,
  // reconciled 2026-06-30 (all 7 plates, both rate tiers, and capacities match):
  //   - entitled_claim_weekday / _offpeak are the two-tier "Entitled Claim per
  //     point" rates; BOTH are stored per truck even when equal (PRJ/PQL/PRH have
  //     no off-peak uplift; PLX/PND jump 11->13; PPE 10->12).
  //   - 4 Wheel (Generic) has NO off-peak row in the sheet; offpeak_rate is
  //     defaulted to the peak rate (11). TODO confirm generic off-peak rate.
  //   - daily_deduction: ONLY PLX 2406 = 2 is client-confirmed. The others
  //     (PND/PRH = 2, PRJ/PQL/PPE = 3) are as-seeded — verify deduction value
  //     with the client before treating as authoritative; left unchanged here.
  // NOTE: live-DB rates are admin-editable, so this seed only governs FRESH
  // deploys; an already-running DB may have drifted and needs an admin-UI edit
  // or a re-seed to match (e.g. a live PLX 2406 weekday rate of 12 vs spec 11).
  for (const t of spec.trucks) {
    const expiry = TRUCK_EXPIRY[t.plate];
    // priority_zones is owned by seedDrivers (driver coverage zones), so it is
    // set only on create here and not overwritten on re-seed of existing rows.
    const syncFields = {
      type: t.type,
      max_pallets: t.max_pallets,
      entitled_claim_weekday: t.weekday_rate,
      entitled_claim_offpeak: t.offpeak_rate,
      daily_deduction_points: t.daily_deduction,
      ...(expiry
        ? {
            insurance_expiry: new Date(expiry.insurance),
            permit_expiry: new Date(expiry.permit),
            road_tax_expiry: new Date(expiry.roadtax),
          }
        : {}),
    };
    await prisma.truck.upsert({
      where: { plate: t.plate },
      update: syncFields, // keep rates/expiries in sync with the spec on re-seed
      create: { plate: t.plate, priority_zones: t.priority_zones, ...syncFields },
    });
  }
  console.log(`Seeded ${spec.trucks.length} trucks.`);
}

async function seedDrivers() {
  for (const d of spec.driver_assignments) {
    const phone = DRIVER_PHONES[d.truck];
    if (!phone) {
      console.warn(`No seed phone for the ${d.truck} driver — skipping.`);
      continue;
    }
    const department = await prisma.department.findUnique({ where: { name: d.department } });
    const password_hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);
    await prisma.user.upsert({
      where: { phone },
      update: {}, // existing accounts untouched — a changed password survives re-seed
      create: {
        phone,
        password_hash,
        name: d.name,
        employee_number: d.employee_no,
        role: "driver",
        status: "active",
        assigned_truck_plate: d.truck,
        department_id: department?.id,
      },
    });
    // Driver coverage zones are the authority for the truck's priority_zones.
    await prisma.truck.update({
      where: { plate: d.truck },
      data: { priority_zones: d.priority_zones },
    });
  }
  console.log(`Seeded ${spec.driver_assignments.length} drivers (password: ${SEED_PASSWORD}).`);
}

async function seedPublicHolidays() {
  // Corrected gazetted 2026 set (shared module; the calendar migration inserts
  // the same rows in prod). Upsert by date so re-seeding never duplicates and
  // never clobbers an admin's later edits to a holiday's name.
  for (const h of PUBLIC_HOLIDAYS_2026) {
    await prisma.publicHoliday.upsert({
      where: { date: h.date },
      update: {},
      create: { date: h.date, name: h.name },
    });
  }
  console.log(`Seeded ${PUBLIC_HOLIDAYS_2026.length} public holidays (2026).`);
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
  // References/ is gitignored (consignee data is NDA-confidential and never
  // committed), so on a fresh clone / clean environment the file is absent.
  // Skip the consignee import gracefully instead of crashing the whole seed.
  if (!fs.existsSync(excelPath)) {
    console.warn(
      `Consignee workbook not found at ${excelPath} — skipping consignee import (References/ is gitignored, NDA-confidential).`
    );
    return;
  }
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
  // Everything here upserts, so re-running the seed is safe: it fills gaps and
  // re-syncs spec values without duplicating rows or wiping live data.
  //
  // Cargo sizes / 4×4-equivalent factors live in spec.cargo but have no DB table
  // of their own — they're consumed in code (api/src/lib/pallets.ts). Logged here
  // so the spec import is complete and visible.
  console.log(
    `Spec cargo: ${spec.cargo.pallet_sizes.map((p) => p.size).join(", ")} (4×4-equivalent factors in api/src/lib/pallets.ts).`
  );

  await seedDepartments();
  await seedZones();
  await seedRouteTypes();
  await seedTrucks();
  await seedDrivers();
  await seedPublicHolidays();
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
