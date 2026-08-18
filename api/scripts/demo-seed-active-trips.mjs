/**
 * DEMO-ONLY: put three drivers on in_progress trips to three different zones,
 * so the admin fleet map has something to show.
 *
 * ⚠ IT GOES THROUGH THE API, NOT THE DATABASE, AND THAT IS THE POINT.
 * Every row is created by the same routes the app calls — requestor books,
 * admin approves (which is where assignment and the rate snapshot happen),
 * driver starts. The result is shaped like real data: real ticket numbers,
 * real audit rows, real incentive snapshots. Writing Trip rows directly would
 * produce trips that look right in a list and are wrong everywhere the
 * booking path does work for you.
 *
 * ⚠ IT CANNOT TOUCH PRODUCTION, AND THERE IS NO OVERRIDE.
 * The gate asks the API to prove the instance is the demo, positively:
 *   1. every truck plate matches UWC 10xx (demo is deliberately re-plated;
 *      production carries nine real plates)
 *   2. the active consignee count is demo-sized (production is four-figure)
 * Production fails both. This matters more than usual here: on 18 Aug 2026 the
 * Railway CLI reported the DEMO project while `--service Postgres` returned
 * PRODUCTION's proxy. A confident answer about the wrong instance is exactly
 * how seed data lands in the live system, so the check is made against the
 * data itself rather than against any name, URL or CLI answer.
 *
 *   node scripts/demo-seed-active-trips.mjs        (DEMO_PW must be set)
 */
const API = "https://uwc-api-demo-production.up.railway.app/api/v1";
const PW = process.env.DEMO_PW;
if (!PW) { console.error("DEMO_PW is not set."); process.exit(1); }

const call = async (path, opts = {}) => {
  const r = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const login = async (phone, password = PW) => {
  const r = await call("/auth/login", { method: "POST", body: JSON.stringify({ phone, password }) });
  if (r.status !== 200) throw new Error(`login failed for ${phone}: ${r.status} ${JSON.stringify(r.body).slice(0,160)}`);
  return r.body.accessToken;
};
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const arr = (b) => (Array.isArray(b) ? b : b?.items ?? []);

const admin = await login("+60100000001");

// ── THE GATE ──────────────────────────────────────────────────────────────
const plates = arr((await call("/trucks", { headers: auth(admin) })).body).map((t) => t.plate ?? t.plate_no);
const nonDemo = plates.filter((p) => !/^UWC 10\d\d$/.test(p));
if (plates.length === 0 || nonDemo.length > 0) {
  console.error(`REFUSING: ${nonDemo.length} of ${plates.length} plates are not demo plates (UWC 10xx). Nothing was written.`);
  process.exit(2);
}
const active = (await call("/consignees/coverage", { headers: auth(admin) })).body?.total_active ?? 99999;
if (active >= 1000) {
  console.error(`REFUSING: ${active} active consignees is production's four-figure count. Nothing was written.`);
  process.exit(2);
}
console.log(`Gate passed — DEMO (${plates.length} synthetic plates, ${active} active consignees)\n`);

const countInProgress = async () =>
  arr((await call("/trips", { headers: auth(admin) })).body).filter((t) => t.status === "in_progress").length;

const before = await countInProgress();
console.log(`in_progress BEFORE: ${before}`);

// ── Pick three consignees in three DIFFERENT zones ────────────────────────
// ⚠ Ask PER ZONE. The bare list is paginated (10 rows) and ignores `limit`, so
// scanning it found only two zones and concluded three routes were impossible
// — a wrong answer produced by reading a page and calling it the set.
// There is no /zones endpoint. These are the fleet's zone codes, the same set
// ZONE_COORDS carries in lib/geo.ts — asking the API for them returned an
// empty list, which read as "no zones exist" rather than "no such route".
const zones = ["P2", "K1", "K2", "P1", "P3", "A1", "A2", "KL"];
const byZone = new Map();
for (const z of zones) {
  if (byZone.size >= 3) break;
  const hit = arr((await call(`/consignees?zone=${encodeURIComponent(z)}`, { headers: auth(admin) })).body)
    .find((c) => c.is_active !== false);
  if (hit) byZone.set(z, hit);
}
const picks = [...byZone.entries()].slice(0, 3);
if (picks.length < 3) {
  console.error(`Only ${picks.length} zones have a consignee (of ${zones.length} zones) — cannot make three separate routes.`);
  process.exit(1);
}
console.log(`zones: ${picks.map(([z]) => z).join(", ")}`);

const routeTypes = arr((await call("/route-types", { headers: auth(admin) })).body);
const routeType = routeTypes.find((r) => /customer delivery/i.test(r.name)) ?? routeTypes[0];

// ⚠ USE THE EXISTING DRIVER↔TRUCK BINDINGS. The first version created a driver
// per trip with `assigned_truck_plate`, which is the normal admin path — but
// the binding is 1:1 and every demo truck is already taken, so two of three
// failed with TRUCK_ALREADY_ASSIGNED. (The users list does not return
// assigned_truck_plate, so it showed "(none)" for drivers that were in fact
// bound — a missing field reading as an empty value.) The trucks list carries
// the driver, so ask there instead of creating anything.
const trucks = arr((await call("/trucks", { headers: auth(admin) })).body);
const crews = trucks
  .map((t) => ({ plate: t.plate ?? t.plate_no, driver: t.driver ?? t.assigned_driver }))
  .filter((c) => c.plate && c.driver?.id && c.driver?.phone);
if (crews.length < 3) {
  console.error(`Only ${crews.length} truck(s) have a driver — cannot run three separate routes.`);
  process.exit(1);
}

// Pickup tomorrow 09:00 MYT. NOT "now": the fleet's operating window is
// 07:00–02:00, so an early-hours pickup is refused at assignment, and B7's
// cut-offs bind a same-day booking made after 13:30.
const t = new Date();
t.setUTCDate(t.getUTCDate() + 1);
t.setUTCHours(1, 0, 0, 0); // 09:00 MYT
const pickup = t.toISOString();

const requestor = await login("+60199990001");
const made = [];

for (let i = 0; i < 3; i++) {
  const [zone, consignee] = picks[i];
  const crew = crews[i];

  const trip = await call("/trips", {
    method: "POST",
    headers: auth(requestor),
    body: JSON.stringify({
      route_type_id: routeType.id,
      pickup_datetime: pickup,
      stops: [{ consignee_id: consignee.id, sequence: 1 }],
      cargo_details: [{ pallet_type: "4x4", quantity: 2 }],
    }),
  });
  if (trip.status !== 201) {
    console.error(`  booking failed (${zone}): ${trip.status} ${JSON.stringify(trip.body).slice(0,220)}`);
    continue;
  }

  const ap = await call(`/trips/${trip.body.id}/approve`, {
    method: "PATCH", headers: auth(admin),
    body: JSON.stringify({ driver_id: crew.driver.id, truck_plate: crew.plate }),
  });
  if (ap.status !== 200) {
    console.error(`  approve failed (${zone}): ${ap.status} ${JSON.stringify(ap.body).slice(0,220)}`);
    continue;
  }

  const driverToken = await login(crew.driver.phone);
  const st = await call(`/trips/${trip.body.id}/status`, {
    method: "PATCH", headers: auth(driverToken), body: JSON.stringify({ action: "start" }),
  });
  if (st.status !== 200) {
    console.error(`  start failed (${zone}): ${st.status} ${JSON.stringify(st.body).slice(0,220)}`);
    continue;
  }
  made.push({ zone, plate: crew.plate, ticket: trip.body.ticket_number });
  console.log(`  ✓ ${zone}  ${crew.plate}  ${crew.driver.name}  ${trip.body.ticket_number}`);
}

const after = await countInProgress();
console.log(`\nin_progress AFTER: ${after}  (was ${before}, created ${made.length})`);
