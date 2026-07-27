// Generates the NATIVE map marker PNGs from the exact WEB (Leaflet divIcon)
// markup, so native and web markers are pixel-identical by construction.
//
// WHY images at all: react-native-maps 1.20 + the new architecture (Fabric)
// allocates a custom-view Marker's bitmap at a constant default size (~36dp)
// regardless of the child's layout — three JS-side fixes failed against it
// (27 Jul 2026, the plant-pin saga). The `image` prop bypasses the
// view-snapshot path entirely. Static markers (plant pin, zone labels) ship
// as these assets; dynamic truck pills wait for the react-native-maps
// upgrade in the next APK.
//
// Run from e2e/ (its Playwright install):  node tools/gen-map-marker-assets.mjs
// Output: mobile/assets/map/*.png at 1x/2x/3x — commit the results.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mobile/assets/map");

// Colors mirror mobile/src/admin/theme.ts + admin/lib/zones.ts — keep in step.
const NAVY = "#1A1F5E";
const YELLOW = "#FFCC00";
const ZONES = [
  { code: "P1", color: "#003087" },
  { code: "P2", color: "#3DAA35" },
  { code: "P3", color: "#F97316" },
  { code: "K1", color: "#9333ea" },
  { code: "K2", color: "#0891b2" },
  { code: "A1", color: "#d97706" },
  { code: "A2", color: "#E53935" },
  { code: "KL", color: "#be185d" },
];

// The web map's plantIcon / zoneLabelIcon markup (map.web.tsx), minus the
// translateY nudge — the Marker `anchor` prop handles positioning natively.
const plantHtml = `
  <div id="m" style="display:inline-flex;flex-direction:column;align-items:center">
    <div style="background:${NAVY};color:${YELLOW};font:700 10px Inter,sans-serif;padding:2px 7px;border-radius:6px;white-space:nowrap;margin-bottom:3px">UWC PLANT</div>
    <div style="width:16px;height:16px;background:${YELLOW};border:3px solid ${NAVY};border-radius:3px;box-sizing:border-box"></div>
  </div>`;

const zoneHtml = (code, color) => `
  <span id="m" style="display:inline-block;color:${color};font:800 13px Inter,sans-serif;opacity:0.75;white-space:nowrap;
        text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;padding:2px">${code}</span>`;

const page = (inner) =>
  `<!doctype html><html><body style="margin:0;background:transparent;display:inline-block">${inner}</body></html>`;

async function capture(browser, html, base) {
  for (const scale of [1, 2, 3]) {
    const ctx = await browser.newContext({ deviceScaleFactor: scale });
    const p = await ctx.newPage();
    await p.setContent(page(html));
    const el = p.locator("#m");
    const suffix = scale === 1 ? "" : `@${scale}x`;
    await el.screenshot({ path: path.join(OUT, `${base}${suffix}.png`), omitBackground: true });
    await ctx.close();
  }
  console.log(`  ${base}.png (+@2x, @3x)`);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
console.log(`writing to ${OUT}`);
await capture(browser, plantHtml, "plant-pin");
for (const z of ZONES) await capture(browser, zoneHtml(z.code, z.color), `zone-${z.code}`);
await browser.close();
console.log("done — commit the generated assets.");
