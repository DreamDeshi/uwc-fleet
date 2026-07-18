/**
 * Proof-report generator (not a test — run via `npm run conformance:report`).
 *
 * Drives the SAME real engines the conformance suite pins and emits a plain,
 * human-readable Markdown report of what every delivery pays and which truck the
 * dispatcher picks — an artifact you can put in front of Mr. Teh as evidence the
 * incentive and driver-selection are correct. Every number is produced by the
 * live engine (not re-typed), so the report can never quietly disagree with the
 * code it documents.
 */
import fs from "fs";
import path from "path";
import { calculateDeliveryIncentive } from "../../src/services/incentiveEngine";
import { selectTruck } from "../../src/services/dispatchEngine";
import {
  DISPATCHABLE,
  ZONES,
  ZONE_POINTS,
  ADJACENCY,
  incTruck,
  drop,
  freeFleet,
  simulateDriverDay,
  D,
  NO_HOLIDAYS,
} from "./fixtures";

const rm = (n: number) => `RM ${n.toFixed(2)}`;
const zonesByPoints = [...ZONES].sort((a, b) => ZONE_POINTS[a] - ZONE_POINTS[b] || a.localeCompare(b));

function firstDropPay(plate: string, zone: string, date: Date): number {
  return calculateDeliveryIncentive({
    rateDateTime: date,
    drops: [drop(zone)],
    zonesDeliveredEarlierToday: [],
    priorPointsToday: 0,
    publicHolidays: NO_HOLIDAYS,
    truck: incTruck(plate),
  }).incentiveThisTrip;
}

function incentiveSection(): string {
  const lines: string[] = [];
  lines.push("## 1. What each delivery pays");
  lines.push("");
  lines.push(
    "Incentive for a driver whose **only** delivery that day is one drop into the zone " +
      "(the full daily deduction lands on it; on multi-delivery days the deduction is " +
      "spread once across the day — see the worked examples below). Weekday = peak " +
      "(Mon–Fri 08:00–18:00); off-peak = weekends, public holidays, and before 08:00 / after 18:00."
  );
  lines.push("");
  const header = ["Zone (points)", ...DISPATCHABLE.map((t) => t.plate)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const zone of zonesByPoints) {
    for (const tier of [
      { label: "weekday", date: D.monday(10) },
      { label: "off-peak", date: D.monday(19) },
    ]) {
      const cells = DISPATCHABLE.map((t) => rm(firstDropPay(t.plate, zone, tier.date)));
      lines.push(`| ${zone} (${ZONE_POINTS[zone]}) · ${tier.label} | ${cells.join(" | ")} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function workedExamplesSection(): string {
  const lines: string[] = [];
  lines.push("## 2. Worked full-day examples (deduction spent once, on the day total)");
  lines.push("");
  const days: Array<{ who: string; plate: string; trips: string[][]; note: string }> = [
    { who: "Driver on PLX 2406", plate: "PLX 2406", trips: [["A2"], ["A2"], ["P1"]], note: "Ipoh, Ipoh again (repeat = 1 pt), Penang" },
    { who: "Driver on PND 1888", plate: "PND 1888", trips: [["K2"], ["K1"]], note: "Kuala Ketil, Kulim" },
    { who: "Driver on PRJ 5292", plate: "PRJ 5292", trips: [["P2"], ["A2"]], note: "Juru (1 pt, floors to 0), then Ipoh — deduction carries" },
  ];
  for (const d of days) {
    const day = simulateDriverDay(d.plate, d.trips, D.monday(10));
    lines.push(`**${d.who}** — ${d.note}`);
    lines.push("");
    lines.push("| Trip | Drops | Points earned | This trip pays |");
    lines.push("| --- | --- | --- | --- |");
    d.trips.forEach((zones, i) => {
      const r = day.perTrip[i];
      lines.push(`| ${i + 1} | ${zones.join(", ")} | ${r.pointsThisTrip} | ${rm(r.incentiveThisTrip)} |`);
    });
    lines.push(`| **Day total** | | **${day.dayPoints} pts − deduction** | **${rm(day.total)}** |`);
    lines.push("");
  }
  return lines.join("\n");
}

function dispatchSection(): string {
  const lines: string[] = [];
  lines.push("## 3. Which truck the system assigns");
  lines.push("");
  lines.push(
    "For an idle fleet, by destination zone and load size (4×4-pallet equivalents). " +
      "A1/A2 (Taiping/Ipoh) are locked to **PLX 2406** while it's free per the rate sheet; " +
      "otherwise the system picks the **smallest truck that fits** so the big lorries stay " +
      "free for big loads. “—” means the load exceeds every truck (needs splitting)."
  );
  lines.push("");
  const bands = [1, 2, 3, 8, 9, 14, 15, 16, 17];
  lines.push(`| Zone | ${bands.map((b) => `${b} plt`).join(" | ")} |`);
  lines.push(`| --- | ${bands.map(() => "---").join(" | ")} |`);
  for (const zone of zonesByPoints) {
    const cells = bands.map((pallets) => {
      const sel = selectTruck({ zone, pallets }, freeFleet(), ADJACENCY);
      return sel ? sel.plate : "—";
    });
    lines.push(`| ${zone} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    "> Note: **4 Wheel** has no assigned driver in the workbook, so the system never " +
      "auto-assigns it (manual/standby only — an open question with Mr. Teh)."
  );
  lines.push("");
  return lines.join("\n");
}

function openQuestionsSection(): string {
  return [
    "## 4. Flagged for confirmation (not bugs — open rules)",
    "",
    "- **A delivery run crossing 6pm** is currently paid entirely at the *first drop's* rate " +
      "(one tier for the whole run). Whether it should instead be priced drop-by-drop is an " +
      "open question with Mr. Teh.",
    "- **Which public-holiday list** drives the off-peak rate (national / Penang state / company) " +
      "is admin-entered and needs confirming.",
    "",
  ].join("\n");
}

const report = [
  "# UWC Fleet — Incentive & Dispatch Conformance Report",
  "",
  "_Generated from the live engines against the authoritative spec (`docs/uwc-spec.json`). " +
    "Every figure below is produced by the same code that runs in production, and is pinned by " +
    "the automated conformance suite (`tests/conformance`). Regenerate with `npm run conformance:report`._",
  "",
  incentiveSection(),
  workedExamplesSection(),
  dispatchSection(),
  openQuestionsSection(),
].join("\n");

const OUT = path.resolve(__dirname, "../../../docs/CONFORMANCE_REPORT.md");
fs.writeFileSync(OUT, report, "utf8");
// eslint-disable-next-line no-console
console.log(`Wrote ${OUT} (${report.length} chars)`);
