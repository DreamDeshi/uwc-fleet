import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  bookTrip,
  approveTrip,
  startTrip,
  arriveDeliverApprove,
  firstRouteTypeId,
  userIdByPhone,
  DRIVERS,
} from "./helpers/flow";
// The CLIENT's exporter, exercised against the REAL API response. Same
// cross-workspace precedent as tests/palletsMirror.test.ts, and the reason
// tsconfig.typecheck.json sets rootDir to the repo root.
import { buildPayrollCsv } from "../../mobile/src/admin/lib/payroll";
import type { PayrollDriverRow } from "../../mobile/src/admin/types";

/**
 * THE CSV THE CLERK ACTUALLY PAYS FROM.
 *
 * The export is a chain across a workspace boundary:
 *
 *     GET /reports/payroll  ->  PayrollDriverRow[]  ->  buildPayrollCsv  ->  file
 *
 * Both ends were tested and the JOIN was not. The client is well behaved — it
 * formats the API's rows rather than re-summing them — but "well behaved" is a
 * property of today's code, and the file a clerk opens is the artefact money
 * moves on. If the two ever disagree, the number that gets paid is the one in
 * the CSV, not the one anybody tested.
 *
 * Cases use the month-crossing fixtures from the bucketing suite, because a
 * trip that lands in the wrong month is the failure most likely to survive
 * review: every total still looks plausible, just in the wrong period.
 */

const JULY = "2026-07";
const AUGUST = "2026-08";
const myt = (iso: string) => new Date(`${iso}+08:00`);

/** Rows exactly as the admin screen receives them. */
async function payrollRows(adminToken: string, month: string): Promise<PayrollDriverRow[]> {
  const res = await api().get(`/api/v1/reports/payroll?month=${month}`).set(auth(adminToken));
  expect(res.status, res.text).toBe(200);
  return res.body.drivers as PayrollDriverRow[];
}

/** Split the export back into its three sections, the way Excel shows them. */
function sections(csv: string): { payroll: string[]; detail: string[]; summary: string[] } {
  const lines = csv.split("\n");
  const detailAt = lines.findIndex((l) => l.startsWith("Trip detail"));
  const summaryAt = lines.findIndex((l) => l.startsWith("Monthly Performance Summary"));
  return {
    payroll: lines.slice(0, detailAt),
    detail: lines.slice(detailAt, summaryAt),
    summary: lines.slice(summaryAt),
  };
}

describe("payroll CSV export — the file must agree with the API that produced it", () => {
  let requestor = "", admin = "", driver = "", driverId = "", rt = "", driverName = "";

  beforeAll(async () => {
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
    driverName = (await prisma.user.findUniqueOrThrow({ where: { id: driverId } })).name;
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  async function completedTrip(): Promise<{ id: string; stopId: string; ticket: string }> {
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    const stopId = t.stops[0].id;
    await arriveDeliverApprove(driver, admin, t.id, stopId);
    return { id: t.id, stopId, ticket: t.ticket_number };
  }

  it("every ringgit total in the file is the one the API computed", async () => {
    const { ticket } = await completedTrip();
    const rows = await payrollRows(admin, AUGUST);
    // Place the trip unambiguously inside August.
    await prisma.trip.updateMany({ data: { pickup_datetime: myt("2026-08-10T09:00:00") } });
    await prisma.tripStop.updateMany({ data: { delivered_at: myt("2026-08-10T11:00:00") } });

    const august = await payrollRows(admin, AUGUST);
    const row = august.find((d) => d.driver_id === driverId);
    expect(row, "the driver must appear in the month they were paid in").toBeTruthy();
    expect(row!.total).toBeGreaterThan(0);

    const csv = buildPayrollCsv(AUGUST, august, []);
    const { payroll, detail } = sections(csv);

    // The clerk's line: name, trip count and total, exactly as the API gave them.
    const line = payroll.find((l) => l.includes(driverName));
    expect(line, `no payroll line for ${driverName}`).toBeTruthy();
    expect(line).toContain(String(row!.trip_count));
    expect(line).toContain(row!.total.toFixed(2));
    expect(line).toContain(AUGUST);

    // And the dispute-tracing line carries the ticket and the same amount.
    const tripLine = detail.find((l) => l.includes(ticket));
    expect(tripLine, `no detail line for ${ticket}`).toBeTruthy();
    expect(tripLine).toContain(row!.trips[0].incentive_earned.toFixed(2));

    // Sanity: the per-trip lines sum to the header total, so a clerk reading
    // either section is paying the same money.
    const perTrip = row!.trips.reduce((sum, t) => sum + t.incentive_earned, 0);
    expect(Number(perTrip.toFixed(2))).toBe(Number(row!.total.toFixed(2)));
    void rows;
  });

  it("a month-crossing trip is exported in the month it was PAID, not booked", async () => {
    // Picked up 31 July, delivered 1 August. The July file must not contain it,
    // or the same work is paid twice across two sheets — the failure the
    // bucketing suite exists for, seen from the artefact end.
    const { id, stopId, ticket } = await completedTrip();
    await prisma.trip.update({ where: { id }, data: { pickup_datetime: myt("2026-07-31T23:30:00") } });
    await prisma.tripStop.update({ where: { id: stopId }, data: { delivered_at: myt("2026-08-01T02:15:00") } });

    const augustCsv = buildPayrollCsv(AUGUST, await payrollRows(admin, AUGUST), []);
    const julyCsv = buildPayrollCsv(JULY, await payrollRows(admin, JULY), []);

    expect(augustCsv).toContain(ticket);
    expect(julyCsv).not.toContain(ticket);
  });

  it("a month with no work exports every driver at ZERO, and no trip lines", async () => {
    // The clerk WILL open a month with no work in it. Documenting the observed
    // shape rather than the one I assumed: the sheet lists EVERY driver, at 0
    // trips and 0.00, because the route selects all drivers and filters their
    // trips. That is reasonable for payroll — "this person earned nothing" is
    // information, and an absent row is easy to misread as an oversight.
    //
    // What must not happen is a trip leaking in from another month, so the
    // detail section is asserted empty.
    await completedTrip(); // real work exists, but in a different month
    const csv = buildPayrollCsv("2026-01", await payrollRows(admin, "2026-01"), []);
    const { payroll, detail } = sections(csv);

    expect(csv).toContain("UWC Driver Payroll");
    expect(payroll).toContain("Driver,Employee No,Trips,Total (RM),Month");

    const line = payroll.find((l) => l.includes(driverName));
    expect(line, "a driver with no work should still be listed").toBeTruthy();
    expect(line).toContain("0.00");

    // Header row only — no per-trip lines at all.
    const tripLines = detail.filter((l) => l.trim() && !l.startsWith("Trip detail") && !l.startsWith("Driver,"));
    expect(tripLines, ["unexpected trip rows in an empty month:", ...tripLines].join("\n")).toEqual([]);
  });

  it("a driver name that Excel would execute is neutralised in the real export", async () => {
    // csvCell guards formula injection, and names are free text. Proven here on
    // a name that travelled the whole chain — DB to API to file — rather than
    // on a hand-made row, because the guard only matters if it is still applied
    // after the API has round-tripped the value.
    await completedTrip();
    await prisma.user.update({ where: { id: driverId }, data: { name: "=cmd|'/c calc'!A1" } });
    try {
      const csv = buildPayrollCsv(AUGUST, await payrollRows(admin, AUGUST), []);
      expect(csv).toContain("'=cmd"); // apostrophe-prefixed → Excel renders text
      expect(csv).not.toMatch(/(^|,)=cmd/m); // never starts a cell bare
    } finally {
      await prisma.user.update({ where: { id: driverId }, data: { name: driverName } });
    }
  });
});
