import { test, type Page, type Route } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * Driver Home — one capture per day-state, from FIXTURES.
 *
 * Home now has five shapes (lib/driverHome.ts) and four of them need a specific
 * arrangement of trips that no seeded account reliably holds. So this spec
 * serves every `/api/v1/**` call itself: no API, no database, no prod account,
 * and each state is exactly reproducible.
 *
 * It asserts nothing. The output is a folder of images to eyeball, in the same
 * spirit as screenshots.spec.ts — but unlike that one it never calls
 * `resetState()`, so it cannot mutate anything.
 *
 *   cd mobile && npx expo start --web --port 8081 --clear     # (must be fresh)
 *   cd e2e && npx playwright test --config playwright.shots.config.ts
 */

const APP = process.env.E2E_MOBILE_URL ?? "http://localhost:8081";
const SHOTS = path.resolve(__dirname, "../screenshots/driver-home");

// ── Fixture builders ───────────────────────────────────────────────────────

const PLATE = "PND 1888";

/** Today at HH:MM local — the day-state logic compares local calendar days. */
function todayAt(h: number, m = 0): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function tomorrowAt(h: number, m = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

type StopSpec = { name: string; area: string; zone: string; delivered?: string };

let stopSeq = 0;
function stop(tripId: string, i: number, s: StopSpec) {
  stopSeq += 1;
  return {
    id: `stop-${stopSeq}`,
    trip_id: tripId,
    sequence: i + 1,
    consignee_id: `c-${stopSeq}`,
    status: s.delivered ? "delivered" : "pending",
    arrived_at: s.delivered ?? null,
    delivered_at: s.delivered ?? null,
    pod_photo: null,
    do_uploaded: Boolean(s.delivered),
    k2_photo: null,
    k2_form_ack: false,
    consignee: {
      id: `c-${stopSeq}`,
      company_name: s.name,
      area: s.area,
      state: "Pulau Pinang",
      zone_code: s.zone,
      zone: { code: s.zone, name: s.area },
      latitude: null,
      longitude: null,
    },
  };
}

function trip(opts: {
  id: string;
  ticket: string;
  status: string;
  pickup: string;
  pallets: number;
  stops: StopSpec[];
}) {
  return {
    id: opts.id,
    ticket_number: opts.ticket,
    requestor_id: "req-1",
    driver_id: "drv-1",
    truck_plate: PLATE,
    route_type_id: "rt-1",
    status: opts.status,
    pickup_datetime: opts.pickup,
    incentive_earned: null,
    is_external: false,
    created_at: opts.pickup,
    requestor: { id: "req-1", name: "Ng Wei Ling", phone: "+60123456789" },
    driver: { id: "drv-1", name: "Ahmad Faizal", phone: "+60100000901" },
    truck: {
      plate: PLATE,
      type: "3 Tan",
      max_pallets: 14,
      entitled_claim_weekday: "11.00",
      entitled_claim_offpeak: "13.00",
      daily_deduction_points: 1,
    },
    route_type: { id: "rt-1", name: "Customer" },
    stops: opts.stops.map((s, i) => stop(opts.id, i, s)),
    cargo_details: [{ id: `cg-${opts.id}`, pallet_type: "4×4", quantity: opts.pallets }],
    documents: [],
  };
}

// The five drops of the design's first trip, one of them in a K2 zone.
const RUN_STOPS: StopSpec[] = [
  { name: "Perai Plastics Sdn Bhd", area: "Perai", zone: "P2" },
  { name: "Northern Cable Works", area: "Perai", zone: "P2" },
  { name: "Sunrise Foods", area: "Sg. Petani", zone: "K2" },
  { name: "Kulim Hi-Tech Assembly", area: "Kulim", zone: "K1" },
  { name: "Tasek Gelugor Feedmill", area: "T. Gelugor", zone: "P3" },
];

const SECOND_STOPS: StopSpec[] = [
  { name: "Kulim Precision Parts", area: "Kulim", zone: "K1" },
  { name: "KHTP Logistics Hub", area: "Kulim", zone: "K1" },
];

function tripsFor(state: string) {
  const first = (status: string, delivered: string[] = []) =>
    trip({
      id: "t-1",
      ticket: "TKT-20260729-021",
      status,
      pickup: todayAt(9, 0),
      pallets: 8,
      stops: RUN_STOPS.map((s, i) => (delivered[i] ? { ...s, delivered: delivered[i] } : s)),
    });
  const second = (status: string, delivered = false) =>
    trip({
      id: "t-2",
      ticket: "TKT-20260729-022",
      status,
      pickup: todayAt(13, 30),
      pallets: 5,
      stops: SECOND_STOPS.map((s) => (delivered ? { ...s, delivered: todayAt(16, 40) } : s)),
    });

  switch (state) {
    case "before":
      return [first("assigned"), second("assigned")];
    case "running":
      return [first("in_progress", [todayAt(9, 42)]), second("assigned")];
    case "between":
      return [
        first("pending_approval", RUN_STOPS.map(() => todayAt(12, 5))),
        second("assigned"),
      ];
    case "finished":
      return [
        first("pending_approval", RUN_STOPS.map(() => todayAt(12, 5))),
        second("completed", true),
      ];
    case "no_trips":
      return [
        trip({
          id: "t-3",
          ticket: "TKT-20260730-004",
          status: "assigned",
          pickup: tomorrowAt(8, 0),
          pallets: 4,
          stops: SECOND_STOPS.concat({ name: "Bertam Agro", area: "Kepala Batas", zone: "P3" }),
        }),
      ];
    default:
      return [];
  }
}

const ME = {
  id: "drv-1",
  phone: "+60100000901",
  name: "Ahmad Faizal",
  employee_number: "H5234",
  role: "driver",
  status: "active",
  language_pref: "en",
  department: { id: "d-1", name: "Logistics" },
  assigned_truck: { plate: PLATE, type: "3 Tan", max_pallets: 14 },
};

/** Last fill 6 days ago → the amber fuel nudge the design frames show. */
function fuelHistory() {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return {
    logs: [{ id: "f-1", logged_at: d.toISOString(), liters: 120, cost: "480.00", odometer: 184320 }],
    summary: { month: "2026-07", total_liters: 480, total_cost: 1920, km_per_liter: 3.1 },
  };
}

// ── Routing ────────────────────────────────────────────────────────────────

async function mockApi(page: Page, state: string) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (url.includes("/auth/login")) {
      return json({ accessToken: "fixture-access", refreshToken: "fixture-refresh", user: ME });
    }
    if (url.includes("/users/me")) return json(ME);
    if (url.includes("/fuel/history")) return json(fuelHistory());
    if (url.includes("/holidays")) return json([]);
    if (/\/trips(\?|$)/.test(url)) return json(tripsFor(state));
    // Anything else this screen touches (push token, settings, health…) — a
    // benign 200 so nothing hangs and no request escapes to a real server.
    return json({});
  });
}

async function shoot(page: Page, state: string, name: string) {
  await mockApi(page, state);
  await page.goto(APP);
  await page.getByPlaceholder("12-345 6789").fill("100000901");
  await page.getByPlaceholder("Enter your password").fill("fixture");
  await page.getByText("Sign In", { exact: true }).click();
  // Wait for the greeting rather than a fixed sleep — it only paints once the
  // session resolved and Home rendered.
  await page.getByText(/Hi, Ahmad Faizal/).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500); // RN-web enter animation
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  fs.mkdirSync(SHOTS, { recursive: true });
});

test("home · before the first trip", async ({ page }) => {
  await shoot(page, "before", "01-before");
});

test("home · trip running", async ({ page }) => {
  await shoot(page, "running", "02-running");
});

test("home · between trips", async ({ page }) => {
  await shoot(page, "between", "03-between");
});

test("home · day finished", async ({ page }) => {
  await shoot(page, "finished", "04-finished");
});

test("home · no trips today", async ({ page }) => {
  await shoot(page, "no_trips", "05-no-trips");
});

test("trips list", async ({ page }) => {
  await mockApi(page, "running");
  await page.goto(APP);
  await page.getByPlaceholder("12-345 6789").fill("100000901");
  await page.getByPlaceholder("Enter your password").fill("fixture");
  await page.getByText("Sign In", { exact: true }).click();
  await page.getByText(/Hi, Ahmad Faizal/).first().waitFor({ timeout: 30_000 });
  await page.getByText("Trips", { exact: true }).last().click();
  await page.getByText("My Trips").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, "06-trips-list.png"), fullPage: true });
});
