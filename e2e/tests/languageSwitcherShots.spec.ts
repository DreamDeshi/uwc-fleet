import { test, expect, type Page, type Route } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * Profile → language switcher: every selected state, both layouts.
 *
 * THE BUG. `segmentText` is fontWeight 700 and `segmentTextActive` bumps it to
 * 800. "Bahasa Malaysia" is the longest of the three labels and only just fits
 * its flex-third at 700 — at 800 it wraps to two lines, and because `segmentBtn`
 * sets `minHeight: 44` (a floor, not a height) the pill grows and the row stops
 * aligning. Selecting either of the other two leaves the row correct, which is
 * why it reads as a Malay-only problem.
 *
 * This spec MEASURES rather than eyeballs: a wrapped label is exactly a label
 * whose box is taller than one line, and a grown pill is one taller than its
 * siblings. Both are asserted for all three selections at both widths, so the
 * regression cannot come back silently. The images are a by-product for review.
 *
 * Fixtures only — no API, no database, no account, and it mutates nothing.
 *
 *   cd mobile && npx expo start --web --port 8081 --clear   # must be FRESH
 *   cd e2e && npx playwright test --config playwright.lang.config.ts
 */

const APP = process.env.E2E_MOBILE_URL ?? "http://localhost:8081";
const SHOTS = path.resolve(__dirname, "../screenshots/language-switcher");

const ME = {
  id: "u-driver",
  phone: "+60100000901",
  name: "Ahmad Faizal",
  role: "driver",
  employee_number: "H5234",
  department_id: "d1",
  language_pref: "en",
  assigned_truck_plate: "PND 1888",
};

/** Every /api/v1 call answered locally, so nothing reaches a real server. */
async function mockApi(page: Page) {
  await page.route("**/api/v1/**", (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/auth/login")) {
      return json({ accessToken: "fixture-access", refreshToken: "fixture-refresh", user: ME });
    }
    if (url.includes("/users/me")) return json(ME);
    if (/\/trips(\?|$)/.test(url)) return json([]);
    if (/\/departments(\?|$)/.test(url)) return json([{ id: "d1", name: "Logistics" }]);
    return json({});
  });
}

/** The three labels, in render order. Endonyms — identical in every locale. */
const LABELS = ["English", "Bahasa Malaysia", "简体中文"] as const;

async function openProfile(page: Page) {
  await mockApi(page);
  await page.goto(APP);
  await page.getByPlaceholder("12-345 6789").fill("100000901");
  await page.getByPlaceholder("Enter your password").fill("fixture");
  await page.getByText("Sign In", { exact: true }).click();
  await page.getByText(/Hi, Ahmad Faizal/).first().waitFor({ timeout: 30_000 });
  await page.getByText("Profile", { exact: true }).last().click();
  await page.getByText("Bahasa Malaysia", { exact: true }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200); // RN-web enter animation
}

/** Box of each label's own text node, and of the pill that contains it. */
async function measure(page: Page) {
  const out: { label: string; textH: number; pillH: number; lines: number }[] = [];
  for (const label of LABELS) {
    const text = page.getByText(label, { exact: true }).first();
    const box = await text.boundingBox();
    const pill = await text.locator("xpath=ancestor::*[@role='button'][1]").boundingBox();
    // lineHeight of the rendered node — a wrapped label is >= 2x it.
    const lineH = await text.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      const lh = parseFloat(cs.lineHeight);
      return Number.isFinite(lh) ? lh : parseFloat(cs.fontSize) * 1.2;
    });
    out.push({
      label,
      textH: Math.round(box!.height),
      pillH: Math.round(pill!.height),
      lines: Math.max(1, Math.round(box!.height / lineH)),
    });
  }
  return out;
}

// NOT serial: each case sets its own viewport and logs in fresh, so they are
// independent — and under `serial` the first failure SKIPS the rest, which
// hid every width above the one that broke.
test.describe.configure({ mode: "default" });
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }));

// 320 = iPhone SE / older small Androids, the narrowest phone still in use;
// 360 = the most common Android width; 390 = the design frame; 1440 = the
// desktop shell. The defect is a width problem, so the small end is the point.
for (const width of [320, 360, 375, 390, 412, 1440] as const) {
  const layout = width === 1440 ? "wide" : `w${width}`;

  for (const [i, selected] of LABELS.entries()) {
    test(`${layout} · ${selected} selected`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await openProfile(page);

      await page.getByText(selected, { exact: true }).first().click();
      await page.waitForTimeout(600); // language swap re-renders the tree

      const rows = await measure(page);
      const slug = ["en", "ms", "zh"][i];

      // Crop to the control: a full-page shot of a 3-pill row buries the defect.
      const segment = page
        .getByText(LABELS[0], { exact: true })
        .first()
        .locator("xpath=ancestor::*[@role='button'][1]/..");
      await segment.screenshot({ path: path.join(SHOTS, `${layout}-${slug}-selected.png`) });

      // ── The assertions the screenshots are evidence for ──────────────────
      for (const r of rows) {
        expect(r.lines, `${layout}/${selected}: "${r.label}" wrapped onto ${r.lines} lines`).toBe(1);
      }
      const heights = rows.map((r) => r.pillH);
      expect(
        Math.max(...heights) - Math.min(...heights),
        `${layout}/${selected}: pill heights differ — ${rows.map((r) => `${r.label}=${r.pillH}`).join(", ")}`
      ).toBe(0);

      console.log(`${layout} · ${selected} selected →`, rows.map((r) => `${r.label}:${r.pillH}px/${r.lines}ln`).join("  "));
    });
  }
}
