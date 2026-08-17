/**
 * Walk the demo run sheet against the LIVE demo, step by step, and report
 * whether each step's tap target and wording still exist.
 *
 * Reports PRESENT/MISSING per step rather than asserting, because the point is
 * to find drift, not to pass.
 */
import { chromium } from "playwright";

const URL_ = "https://uwc-mobile-demo-production.up.railway.app";
const OUT = process.argv[2];
const b = await chromium.launch();

const report = [];
const check = async (p, label, what, exact = true) => {
  const n = await p.getByText(what, { exact }).count();
  report.push(`${n > 0 ? "  OK  " : "  !!  "} ${label}: "${what}"`);
  return n > 0;
};

const login = async (p, role) => {
  await p.goto(URL_, { waitUntil: "networkidle" });
  await p.getByText(`Try as ${role}`, { exact: true }).click();
  await p.waitForTimeout(8000);
};

// ── ADMIN (desktop, as a judge holding the phone would see it at the poster we
//    still lead on the admin screens) ──
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  await login(p, "Admin");
  report.push("ADMIN LANE");
  await check(p, "step 1 sidebar", "Dashboard");
  await check(p, "step 2 sidebar", "Trip Management");

  await p.getByText("Trip Management", { exact: true }).first().click();
  await p.waitForTimeout(4000);
  await check(p, "step 2 status chip", "ASSIGNED");
  await check(p, "step 2 date filter", "Aug 17", false);
  await p.screenshot({ path: `${OUT}/walk-trips.png` });

  await p.getByText("POD Approvals", { exact: true }).first().click();
  await p.waitForTimeout(4000);
  await check(p, "step 3 queue", "TKT-20260817-001");
  await check(p, "step 3 money", "RM 18.00");
  await check(p, "step 3 points", "4 pts", false);
  await check(p, "step 3 POD button", "POD", false);

  await p.getByText("Incentive Rates", { exact: true }).first().click();
  await p.waitForTimeout(3500);
  await p.getByText("Formula & Examples", { exact: true }).first().click();
  await p.waitForTimeout(3000);
  await check(p, "step 4 rules card", "Calculation Rules");
  await check(p, "step 4 bands", "Rate Bands");
  await check(p, "step 4 peak window", "08:00", false);
  await check(p, "step 4 NOT the error state", "Could not load the pay rules from the server.");
  await p.screenshot({ path: `${OUT}/walk-formula.png` });

  await p.getByText("Sustainability", { exact: true }).first().click();
  await p.waitForTimeout(3500);
  await check(p, "step 5 co2", "CO", false);
  await p.screenshot({ path: `${OUT}/walk-sustainability.png` });

  // Screens the redesign changed that the sheet's fallbacks mention
  await p.getByText("Reports", { exact: true }).first().click();
  await p.waitForTimeout(3500);
  await check(p, "reports tabs", "Overview");
  await check(p, "reports tabs", "Payroll");
  await p.screenshot({ path: `${OUT}/walk-reports.png` });

  await p.getByText("Calendar", { exact: true }).first().click();
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${OUT}/walk-calendar.png` });
  await p.close();
}

// ── DRIVER (phone) ──
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  await login(p, "Driver");
  report.push("DRIVER LANE");
  const body = (await p.locator("body").innerText()).replace(/\s+/g, " ");
  report.push(`  home text: ${body.slice(0, 150)}`);
  await check(p, "step 2 start control", "Start this trip");
  await check(p, "step 4 tab", "Earnings");
  await p.screenshot({ path: `${OUT}/walk-driver-home.png` });
  await p.close();
}

// ── REQUESTOR (phone) ──
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  await login(p, "Requestor");
  report.push("REQUESTOR LANE");
  await check(p, "step 1 cta", "New Booking", false);
  const bookings = p.getByText("Bookings", { exact: true }).last();
  if (await bookings.count()) { await bookings.click(); await p.waitForTimeout(3500); }
  await check(p, "step 3 status", "PENDING", false);
  await p.screenshot({ path: `${OUT}/walk-requestor.png` });
  await p.close();
}

await b.close();
console.log(report.join("\n"));
