/**
 * DEMO-ONLY location simulator — drivers moving on the admin fleet map.
 *
 * ⚠ IT POSTS THROUGH THE API, AS A DRIVER PHONE DOES. `POST /locations` is the
 * same endpoint the app calls on its 30 s tick, so the rows are shaped exactly
 * like real ones. It needs no database URL, which also means there is no
 * connection string to get wrong — and on 18 Aug 2026 getting one wrong was a
 * live risk: `railway status` reported the DEMO project while
 * `--service Postgres` returned PRODUCTION's proxy.
 *
 * ⚠ IT CANNOT TOUCH PRODUCTION, AND THERE IS NO OVERRIDE.
 * The gate asks the instance to prove it is the demo, positively:
 *   1. every truck plate matches UWC 10xx (production has nine real plates)
 *   2. the active consignee count is demo-sized (production is four-figure)
 * Production fails both. There is no --force and no env var, because the only
 * reason to want one is to do the thing this prevents.
 *
 *   START   DEMO_PW=… node scripts/demo-gps-sim.mjs        (Ctrl-C stops it)
 *   STOP    Ctrl-C, or `taskkill /F /IM node.exe` if backgrounded
 */
const API = "https://uwc-api-demo-production.up.railway.app/api/v1";
const PW = process.env.DEMO_PW;
if (!PW) { console.error("DEMO_PW is not set."); process.exit(1); }

/**
 * Tick interval, DERIVED not guessed: the API calls a fix stale at
 * GPS_STALE_AFTER_MS (3 min, api/src/lib/gpsPosition.ts) and the admin fleet
 * query refetches every 20–30 s. 30 s is a sixth of the stale window, so a
 * truck stays "live" even if a tick is missed, and the pin has visibly moved
 * between two refreshes — which is the actual requirement.
 */
const TICK_MS = 30_000;
const STEP = 0.06;

const PLANT = { latitude: 5.216238509805299, longitude: 100.4445982584094 };
const ZONE = {
  P1: { latitude: 5.4145, longitude: 100.3292 }, P2: { latitude: 5.35, longitude: 100.4 },
  P3: { latitude: 5.5333, longitude: 100.4833 }, K1: { latitude: 5.365, longitude: 100.561 },
  K2: { latitude: 5.647, longitude: 100.487 }, A1: { latitude: 4.85, longitude: 100.7333 },
  A2: { latitude: 4.5975, longitude: 101.0901 }, KL: { latitude: 3.139, longitude: 101.6869 },
};

const call = async (path, opts = {}) => {
  const r = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const login = async (phone) => {
  const r = await call("/auth/login", { method: "POST", body: JSON.stringify({ phone, password: PW }) });
  if (r.status !== 200) throw new Error(`login failed for ${phone}: ${r.status}`);
  return r.body.accessToken;
};
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const arr = (b) => (Array.isArray(b) ? b : b?.items ?? []);

const admin = await login("+60100000001");

// ── THE GATE ──────────────────────────────────────────────────────────────
const trucks = arr((await call("/trucks", { headers: auth(admin) })).body);
const plates = trucks.map((t) => t.plate ?? t.plate_no);
const nonDemo = plates.filter((p) => !/^UWC 10\d\d$/.test(p));
if (plates.length === 0 || nonDemo.length > 0) {
  console.error(`REFUSING: ${nonDemo.length} of ${plates.length} plates are not demo plates (UWC 10xx). Nothing was written.`);
  process.exit(2);
}
const activeConsignees = (await call("/consignees/coverage", { headers: auth(admin) })).body?.total_active ?? 99999;
if (activeConsignees >= 1000) {
  console.error(`REFUSING: ${activeConsignees} active consignees is production's count. Nothing was written.`);
  process.exit(2);
}
console.log(`Gate passed — DEMO (${plates.length} synthetic plates, ${activeConsignees} active consignees)`);

// ── Who is moving ─────────────────────────────────────────────────────────
const trips = arr((await call("/trips", { headers: auth(admin) })).body).filter((t) => t.status === "in_progress");
const byPlate = new Map(trucks.map((t) => [t.plate ?? t.plate_no, t.driver ?? t.assigned_driver]));
const tracks = [];
for (const t of trips) {
  const driver = byPlate.get(t.truck_plate);
  if (!driver?.phone) continue;
  const zone = t.stops?.[0]?.consignee?.zone_code ?? "P2";
  tracks.push({
    tripId: t.id, ticket: t.ticket_number, plate: t.truck_plate, phone: driver.phone,
    name: driver.name, zone, to: ZONE[zone] ?? ZONE.P2, t: tracks.length * 0.25, dir: 1,
  });
}
if (tracks.length === 0) { console.error("No in_progress trips with a driver phone."); process.exit(1); }

for (const tr of tracks) tr.token = await login(tr.phone);
console.log(`\nMoving ${tracks.length} truck(s), a fix every ${TICK_MS / 1000}s:`);
for (const tr of tracks) console.log(`  ${tr.plate}  ${tr.name}  ${tr.ticket} → ${tr.zone}`);
console.log("\nCtrl-C to stop.\n");

process.on("SIGINT", () => { console.log("\nstopped."); process.exit(0); });

let n = 0;
for (;;) {
  for (const tr of tracks) {
    const lat = PLANT.latitude + (tr.to.latitude - PLANT.latitude) * tr.t;
    const lng = PLANT.longitude + (tr.to.longitude - PLANT.longitude) * tr.t;
    const r = await call("/locations", {
      method: "POST", headers: auth(tr.token),
      body: JSON.stringify({ points: [{ trip_id: tr.tripId, latitude: lat, longitude: lng, recorded_at: new Date().toISOString() }] }),
    });
    if (r.status !== 200 && r.status !== 201) {
      console.error(`\n  ${tr.plate} post failed: ${r.status} ${JSON.stringify(r.body).slice(0,140)}`);
    }
    tr.t += STEP * tr.dir;
    if (tr.t >= 1) { tr.t = 1; tr.dir = -1; }
    if (tr.t <= 0) { tr.t = 0; tr.dir = 1; }
  }
  n++;
  process.stdout.write(`\rtick ${n} — ${tracks.length} fix(es) posted at ${new Date().toLocaleTimeString()}  `);
  await new Promise((r) => setTimeout(r, TICK_MS));
}
