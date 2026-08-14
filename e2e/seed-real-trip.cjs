/**
 * Drive ONE trip through the REAL delivery path on the demo, so the money on
 * screen is computed by the engine rather than written in.
 *
 * The only injected thing is the POD image bytes (there is no camera in a
 * headless browser) — and even that goes through the real upload route to
 * Cloudinary, so `pod_photo` is a genuine signed asset. Every number
 * (points_awarded, rate_used, deduction_applied, incentive_earned) is produced
 * by finalization.
 */
const API = "https://uwc-api-demo-production.up.railway.app/api/v1";
const PW = "UwcDemo2026!";

async function j(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const login = async (phone) => (await j("/auth/login", { method: "POST", body: JSON.stringify({ phone, password: PW }) })).body.accessToken;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

(async () => {
  const admin = await login("+60100000001");
  const driver = await login("+60100000101");
  console.log("tokens:", !!admin, !!driver);

  // A consignee in Ipoh (A2) — 6 zone points, the workbook's worked example.
  const cons = await j("/consignees?zone=A2&limit=5", { headers: auth(admin) });
  const list = Array.isArray(cons.body) ? cons.body : cons.body.consignees || [];
  const target = list.find((c) => c.zone_code === "A2") || list[0];
  console.log("consignee:", target && `${target.company_name} (${target.zone_code})`);

  const rt = (await j("/route-types", { headers: auth(admin) })).body;
  const delivery = rt.find((r) => r.name === "Customer Delivery");

  // Booked BY THE ADMIN with a stated cut-off reason: it is past 13:30 MYT, and
  // that is exactly the override B7 provides. Nothing here bypasses the rule.
  const pickup = new Date(Date.now() + 30 * 60000).toISOString();
  const booked = await j("/trips", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({
      route_type_id: delivery.id,
      pickup_datetime: pickup,
      stops: [{ consignee_id: target.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 4 }],
      cutoff_override_reason: "Demo capture for the A5 report",
    }),
  });
  console.log("booked:", booked.status, booked.body.ticket_number || JSON.stringify(booked.body).slice(0, 160));
  if (booked.status !== 201) return;
  const trip = booked.body;

  const drv = (await j("/reports/drivers", { headers: auth(admin) })).body;
  const d1 = (Array.isArray(drv) ? drv : drv.drivers || []).find((x) => (x.name || "").includes("Driver 1"));
  const assigned = await j(`/trips/${trip.id}/approve`, {
    method: "PATCH",
    headers: auth(admin),
    body: JSON.stringify({ driver_id: d1.driver_id || d1.id, truck_plate: "UWC 1003", force: true }),
  });
  console.log("assigned:", assigned.status, assigned.status !== 200 ? JSON.stringify(assigned.body).slice(0, 200) : "ok");

  const started = await j(`/trips/${trip.id}/status`, { method: "PATCH", headers: auth(driver), body: JSON.stringify({ action: "start" }) });
  console.log("started:", started.status);
  const stopId = trip.stops[0].id;
  const arrived = await j(`/trips/${trip.id}/status`, { method: "PATCH", headers: auth(driver), body: JSON.stringify({ action: "arrived", stop_id: stopId }) });
  console.log("arrived:", arrived.status);

  // POD upload through the REAL route (multipart) — a 1x1 PNG stands in for the
  // camera, but the storage, signing and gate are all genuine.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("photo", new Blob([png], { type: "image/png" }), "pod.png");
  const up = await fetch(`${API}/trips/${trip.id}/stops/${stopId}/pod`, { method: "POST", headers: auth(driver), body: fd });
  console.log("pod upload:", up.status, (await up.text()).slice(0, 120));

  const delivered = await j(`/trips/${trip.id}/status`, { method: "PATCH", headers: auth(driver), body: JSON.stringify({ action: "delivered", stop_id: stopId }) });
  console.log("delivered:", delivered.status, JSON.stringify(delivered.body).slice(0, 200));
  console.log("TICKET:", trip.ticket_number);
})();
