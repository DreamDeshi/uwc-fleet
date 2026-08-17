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

type StopSpec = {
  name: string;
  area: string;
  zone: string;
  delivered?: string;
  /** A real geocoded position. Null on most fixtures — that IS the common case
   *  in production (574 of 1,564 consignees), and it makes the map draw the
   *  zone centroid. The first run stop carries one so the map shots show a
   *  destination pin at a place rather than a shared zone dot. */
  lat?: number;
  lng?: number;
};

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
      latitude: s.lat ?? null,
      longitude: s.lng ?? null,
      geocode_match_type: s.lat == null ? null : "ROOFTOP",
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
  { name: "Perai Plastics Sdn Bhd", area: "Perai", zone: "P2", lat: 5.3814, lng: 100.3915 },
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

// Swapped per test so the exception card can be photographed in each state.
// Only read when EXPO_PUBLIC_FEATURE_EXCEPTIONS=true — the flow is flag-dark.
let exceptionFixture: Record<string, unknown> | null = null;

function exceptionIn(state: string) {
  return {
    id: "exc-1",
    trip_id: "t-1",
    trip_stop_id: "stop-2",
    category: "customer_site",
    reason: "Gate locked, nobody at the site to receive",
    reported_by: "drv-1",
    reported_at: new Date().toISOString(),
    current_state: state,
    resolution: null,
    resolved_at: null,
    closed_at: null,
    is_open: true,
    version: 1,
    created_at: new Date().toISOString(),
    evidence: [],
    actions: [],
  };
}

const DEPARTMENTS = [
  { id: "d-1", name: "Logistics" },
  { id: "d-2", name: "Production" },
  { id: "d-3", name: "Quality Assurance" },
];

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
    // The truck's last posted fix — what LiveTripMap draws as the DRIVER
    // marker. Without this the tracking maps render two pins and no driver,
    // and the marker that is second in the size order goes unreviewed.
    // The pre-computed road geometry (RouteLeg). Without it the map draws NO
    // line at all — correct behaviour since #172, and it means a capture taken
    // without this fixture cannot show the route line's weight. A coarse
    // Batu Kawan -> Perai path is enough to judge the stroke against the
    // motorways underneath it.
    if (/\/trips\/[^/]+\/route/.test(url)) {
      return json({
        polyline: [
          { latitude: 5.2162, longitude: 100.4446 },
          { latitude: 5.2571, longitude: 100.4489 },
          { latitude: 5.2903, longitude: 100.4372 },
          { latitude: 5.3225, longitude: 100.4218 },
          { latitude: 5.3508, longitude: 100.4074 },
          { latitude: 5.3814, longitude: 100.3915 },
        ],
      });
    }
    if (/\/trips\/[^/]+\/location/.test(url)) {
      return json({
        latitude: 5.3421,
        longitude: 100.4102,
        recorded_at: new Date().toISOString(),
        stale: false,
      });
    }
    if (url.includes("/fuel/history")) return json(fuelHistory());
    if (url.includes("/holidays")) return json([]);
    if (/\/departments(\?|$)/.test(url)) return json(DEPARTMENTS);
    if (/\/exception$/.test(url) && route.request().method() === "GET") {
      return json({ exception: exceptionFixture });
    }
    if (/\/trips(\?|$)/.test(url)) return json(tripsFor(state));
    // GET /trips/:id — the Active Trip screen's own fetch. Without this the
    // list mock is not enough and the screen lands on its error state.
    const detail = url.match(/\/trips\/([^/?]+)(\?|$)/);
    if (detail) {
      const one = tripsFor(state).find((tr) => tr.id === detail[1]);
      if (one) return json({ ...one, timeline: [] });
    }
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

// ── The screens either side of Home ────────────────────────────────────────

test("sign in", async ({ page }) => {
  await mockApi(page, "before");
  await page.goto(APP);
  await page.getByPlaceholder("12-345 6789").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "07-login.png"), fullPage: true });
});

test("register · step 1", async ({ page }) => {
  await mockApi(page, "before");
  await page.goto(APP);
  await page.getByText("Create Account", { exact: true }).first().click();
  await page.getByText("Personal Details").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "08-register-1.png"), fullPage: true });
});

test("register · step 2", async ({ page }) => {
  await mockApi(page, "before");
  await page.goto(APP);
  await page.getByText("Create Account", { exact: true }).first().click();
  await page.getByPlaceholder("e.g. Ahmad Razak Bin Abdullah").fill("Ahmad Faizal Bin Rahman");
  await page.getByPlaceholder("e.g. H5234").fill("H5234");
  await page.getByText("Select your department").click();
  // selector-ok: fixture company name, not i18n copy
  await page.getByText("Logistics", { exact: true }).last().click();
  await page.getByPlaceholder("12-345 6789").last().fill("123456789");
  await page.getByText("Next", { exact: true }).click();
  await page.getByText("Confirm Password", { exact: true }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "09-register-2.png"), fullPage: true });
});

test("profile", async ({ page }) => {
  await mockApi(page, "before");
  await page.goto(APP);
  await page.getByPlaceholder("12-345 6789").fill("100000901");
  await page.getByPlaceholder("Enter your password").fill("fixture");
  await page.getByText("Sign In", { exact: true }).click();
  await page.getByText(/Hi, Ahmad Faizal/).first().waitFor({ timeout: 30_000 });
  await page.getByText("Profile", { exact: true }).last().click();
  // selector-ok: fixture driver name, not i18n copy
  await page.getByText("Ahmad Faizal", { exact: true }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, "10-profile.png"), fullPage: true });
});

// ── Delivery-exception flow (frames 19, 21, 22) ────────────────────────────
// Only meaningful when Metro was started with
// EXPO_PUBLIC_FEATURE_EXCEPTIONS=true; the flow is otherwise hidden, so these
// skip themselves rather than failing a normal run.
const EXCEPTIONS_ON = process.env.E2E_EXCEPTIONS === "1";

async function intoActiveTrip(page: Page) {
  await page.goto(APP);
  await page.getByPlaceholder("12-345 6789").fill("100000901");
  await page.getByPlaceholder("Enter your password").fill("fixture");
  await page.getByText("Sign In", { exact: true }).click();
  await page.getByText(/Hi, Ahmad Faizal/).first().waitFor({ timeout: 30_000 });
  await page.getByText("Continue trip", { exact: true }).click();
  // The GPS consent explainer (frame 12) opens over the Active Trip screen on
  // first entry and blocks everything behind it.
  const notNow = page.getByText("Not now", { exact: true });
  await notNow.waitFor({ timeout: 20_000 }).catch(() => {});
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.getByText(/Drive there in Google Maps|Call consignee/).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
}

test("exception · report sheet", async ({ page }) => {
  test.skip(!EXCEPTIONS_ON, "needs EXPO_PUBLIC_FEATURE_EXCEPTIONS=true");
  exceptionFixture = null;
  await mockApi(page, "running");
  await intoActiveTrip(page);
  // The button reads "Problem" in the narrow chip row and "Report a problem"
  // in the wide one, depending on which stop card is showing.
  await page.getByText(/^(Problem|Report a problem)$/).first().click();
  await page.getByText("What went wrong?").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "11-exception-report.png"), fullPage: true });
});

test("exception · reported, on hold", async ({ page }) => {
  test.skip(!EXCEPTIONS_ON, "needs EXPO_PUBLIC_FEATURE_EXCEPTIONS=true");
  exceptionFixture = exceptionIn("reported");
  await mockApi(page, "running");
  await intoActiveTrip(page);
  await page.getByText("Exception reported").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOTS, "12-exception-reported.png"), fullPage: true });
});

test("exception · more evidence needed", async ({ page }) => {
  test.skip(!EXCEPTIONS_ON, "needs EXPO_PUBLIC_FEATURE_EXCEPTIONS=true");
  exceptionFixture = exceptionIn("more_evidence");
  await mockApi(page, "running");
  await intoActiveTrip(page);
  await page.getByText("Exception reported").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOTS, "13-exception-more-evidence.png"), fullPage: true });
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

// ── The map band (owner review, 18 Aug 2026) ───────────────────────────────
// The Active Trip map is the one surface a diff cannot review: pin weight,
// connector lines and band height are only visible in an image. Captured at
// 390 — the design width, and the width the driver actually holds.
//
// ⚠ NOT fullPage. RN-Web scrolls an inner container, so fullPage silently
// returns the viewport anyway; asking for it just misleads the next reader.
// Set SHOT_TAG=before / after to keep two sets side by side.
const MAP_TAG = process.env.SHOT_TAG ?? "shot";

test("active trip · map band", async ({ page }) => {
  await mockApi(page, "running");
  await intoActiveTrip(page);
  await page.screenshot({ path: path.join(SHOTS, `20-active-trip-map-${MAP_TAG}.png`) });
});

test("trip details · tracking map", async ({ page }) => {
  // The second map surface, and the only one that draws the DRIVER marker from
  // a server fix. Requestor tracking renders the same component.
  await mockApi(page, "running");
  await page.goto(APP);
  await page.getByPlaceholder("12-345 6789").fill("100000901");
  await page.getByPlaceholder("Enter your password").fill("fixture");
  await page.getByText("Sign In", { exact: true }).click();
  await page.getByText(/Hi, Ahmad Faizal/).first().waitFor({ timeout: 30_000 });
  await page.getByText("Trips", { exact: true }).last().click();
  await page.getByText("My Trips").first().waitFor({ timeout: 15_000 });
  // ⚠ .last(), not .first(): RN-Web renders a 0×0 duplicate of every Text node,
  // and Playwright resolves the invisible one first — it never becomes
  // "visible and stable", so the click times out on an element that is on
  // screen. Known harness quirk, not a UI defect.
  // selector-ok: a fixture ticket number, not i18n copy
  await page.getByText("TKT-20260729-021").last().click();
  await page.waitForTimeout(4000); // Leaflet tiles
  await page.screenshot({ path: path.join(SHOTS, `21-trip-details-map-${MAP_TAG}.png`) });
});

test("active trip · map band, with the driver's own position", async ({ page, context }) => {
  // The DRIVER marker is drawn from this device's GPS, not from the server, so
  // it cannot be faked with a route mock — the trip-details map passes
  // live={false} on purpose ("route preview before the trip starts"). Granting
  // geolocation is the only way to actually SEE the marker that is second in
  // the size order, and reporting on a pin I had not looked at would be
  // exactly the mistake this capture exists to prevent.
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 5.3421, longitude: 100.4102 }); // Juru, on the way
  await mockApi(page, "running");
  await intoActiveTrip(page);
  const enable = page.getByText(/Tap to enable/).last();
  if (await enable.isVisible().catch(() => false)) {
    await enable.click();
    // Tapping the pill re-opens the GPS consent explainer that intoActiveTrip
    // dismissed with "Not now". Accept it this time — that is what actually
    // starts tracking and draws the marker.
    const accept = page.getByText("Enable Location", { exact: true }).last();
    await accept.waitFor({ timeout: 10_000 }).catch(() => {});
    if (await accept.isVisible().catch(() => false)) await accept.click();
    await page.waitForTimeout(4500);
  }
  await page.screenshot({ path: path.join(SHOTS, `22-active-trip-map-live-${MAP_TAG}.png`) });
});
