/**
 * Second demo trip, stopped deliberately at "arrived, POD attached, not yet
 * confirmed" — the state fig-3.5 needs. Everything is the real route; only the
 * image BYTES are synthetic, because a headless browser has no camera. The
 * placeholder is drawn to say so on its face rather than imitating a photo.
 */
const { chromium } = require("@playwright/test");
const API = "https://uwc-api-demo-production.up.railway.app/api/v1";
const PW = "UwcDemo2026!";

async function j(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
}
const login = async (p) => (await j("/auth/login", { method: "POST", body: JSON.stringify({ phone: p, password: PW }) })).body.accessToken;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function placeholderPng() {
  const b = await chromium.launch();
  const p = await b.newPage();
  const dataUrl = await p.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200; c.height = 900;
    const g = c.getContext("2d");
    g.fillStyle = "#d7dbe0"; g.fillRect(0, 0, 1200, 900);
    g.fillStyle = "#9aa3ad"; g.fillRect(80, 120, 1040, 660);
    g.fillStyle = "#ffffff"; g.font = "bold 62px sans-serif"; g.textAlign = "center";
    g.fillText("DEMO PLACEHOLDER", 600, 420);
    g.font = "38px sans-serif";
    g.fillText("proof-of-delivery image", 600, 490);
    g.fillText("(no camera in a headless capture)", 600, 545);
    return c.toDataURL("image/png");
  });
  await b.close();
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

(async () => {
  const admin = await login("+60100000001");
  const png = await placeholderPng();

  const cons = await j("/consignees?zone=P1&limit=5", { headers: auth(admin) });
  const list = Array.isArray(cons.body) ? cons.body : cons.body.consignees || [];
  const target = list[0];
  const rt = (await j("/route-types", { headers: auth(admin) })).body;
  const delivery = rt.find((r) => r.name === "Customer Delivery");

  const booked = await j("/trips", {
    method: "POST", headers: auth(admin),
    body: JSON.stringify({
      route_type_id: delivery.id,
      pickup_datetime: new Date(Date.now() + 30 * 60000).toISOString(),
      stops: [{ consignee_id: target.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 2 }],
      cutoff_override_reason: "Demo capture for the A5 report",
    }),
  });
  console.log("booked:", booked.status, booked.body.ticket_number, "→", target.company_name, target.zone_code);
  if (booked.status !== 201) return console.log(JSON.stringify(booked.body).slice(0, 300));

  const all = await j("/trips?limit=50", { headers: auth(admin) });
  const t = (Array.isArray(all.body) ? all.body : all.body.trips).find((x) => x.ticket_number === booked.body.ticket_number);
  console.log("dispatched to:", t.truck_plate, t.driver && t.driver.name);
  const num = (t.driver.name.match(/\d+/) || ["1"])[0];
  const phone = "+601000001" + String(num).padStart(2, "0");
  const drv = await login(phone);

  const stopId = t.stops[0].id;
  console.log("start:", (await j(`/trips/${t.id}/status`, { method: "PATCH", headers: auth(drv), body: JSON.stringify({ action: "start" }) })).status);
  console.log("arrived:", (await j(`/trips/${t.id}/status`, { method: "PATCH", headers: auth(drv), body: JSON.stringify({ action: "arrived", stop_id: stopId }) })).status);

  const fd = new FormData();
  fd.append("photo", new Blob([png], { type: "image/png" }), "pod.png");
  const up = await fetch(`${API}/trips/${t.id}/stops/${stopId}/pod`, { method: "POST", headers: auth(drv), body: fd });
  console.log("pod upload:", up.status);
  console.log("TICKET:", t.ticket_number, "DRIVER PHONE:", phone.replace("+60", ""), "CONSIGNEE:", target.company_name);
})();
