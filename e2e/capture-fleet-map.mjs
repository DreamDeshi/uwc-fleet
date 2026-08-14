/**
 * CAPTURE-ONLY: photograph the desktop admin dashboard's fleet map and MEASURE
 * it, to verify the idle-roster overlay change.
 *
 * Not a test — it asserts nothing and never runs in CI. It exists because a
 * layout change that has not been rendered is a guess: two desktop fixes
 * shipped unrendered on 9 Aug and both came back wrong, one with the wrong root
 * cause entirely (a card sizing to its taller sibling, not to the map inside).
 *
 * It MEASURES as well as photographs, because a screenshot alone could not
 * settle the earlier question of whether a white band was a layout defect or
 * just unloaded OSM tiles. getBoundingClientRect answers that in seconds.
 *
 *   node capture-fleet-map.mjs <export-dir> <out-dir>
 *
 * Serve on 8081: the API's CORS default allows http://localhost:8081 only, so
 * any other port fails login at the preflight.
 */
import { chromium } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
const PORT = 8081;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".ico": "image/x-icon", ".map": "application/json",
};

// ⚠ Windows: resolve DIST before the containment check. A forward-slash literal
// compared against path.join's backslashes makes startsWith fail, every asset
// 404s to index.html, and the page renders blank.
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = path.resolve(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const indexed = path.join(file, "index.html");
    file = fs.existsSync(indexed) ? indexed : path.join(DIST, "index.html");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const probe = async (page) =>
  page.evaluate(() => {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) };
    };
    const leaflet = document.querySelector(".leaflet-container");
    // The map's card: walk up from the leaflet container until the box stops
    // growing horizontally — that is the Card the map lives in.
    let card = leaflet?.parentElement ?? null;
    for (let i = 0; i < 6 && card?.parentElement; i++) {
      const next = card.parentElement;
      if (next.getBoundingClientRect().width > card.getBoundingClientRect().width + 1) card = next;
      else break;
    }
    // The overlay panel: the absolutely-positioned box sitting bottom-left
    // inside the same wrapper as the leaflet container.
    const wrapper = leaflet?.parentElement ?? null;
    const overlay = wrapper
      ? [...wrapper.children].find((c) => c !== leaflet && getComputedStyle(c).position === "absolute" && c.getBoundingClientRect().x < wrapper.getBoundingClientRect().x + 60)
      : null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      leaflet: r(leaflet),
      card: r(card),
      overlay: r(overlay ?? null),
      overlayText: overlay ? overlay.innerText.replace(/\s+/g, " ").trim().slice(0, 120) : null,
      // Prove the chip clears Leaflet's zoom buttons rather than sitting on them.
      zoom: r(document.querySelector(".leaflet-control-zoom")),
      // Is the chip reachable WITHOUT scrolling? This is what the first attempt
      // got wrong: bottom-left measured y=1215 in a 900px viewport.
      chipInFirstScreen: overlay ? overlay.getBoundingClientRect().bottom <= window.innerHeight : null,
      tiles: document.querySelectorAll(".leaflet-tile-loaded").length,
    };
  });

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "en-US",
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("  [browser error]", m.text().slice(0, 160)); });

  await page.goto(`http://localhost:${PORT}`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("12-345 6789").fill("100000001");
  await page.getByPlaceholder("Enter your password").fill("Password123");
  await page.getByText("Sign In", { exact: true }).click();

  await page.getByText("Live fleet overview", { exact: false }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6_000); // let OSM tiles land so the shot is honest

  const before = await probe(page);
  await page.screenshot({ path: path.join(OUT, "dashboard-collapsed.png") });
  console.log("\nCOLLAPSED (chip only)");
  console.log(JSON.stringify(before, null, 2));

  // Open the roster. `countIdle` renders "{{n}} idle" — 9 on a fresh seed.
  const chip = page.getByText(/^\d+ idle$/).first();
  const found = await chip.count();
  if (found) {
    await chip.click();
    await page.waitForTimeout(1_200);
    const after = await probe(page);
    await page.screenshot({ path: path.join(OUT, "dashboard-expanded.png") });
    console.log("\nEXPANDED (roster open)");
    console.log(JSON.stringify(after, null, 2));
  } else {
    console.log("\n⚠ idle chip NOT FOUND — nothing to expand");
  }

  await browser.close();
  server.close();
  console.log(`\nimages → ${OUT}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
