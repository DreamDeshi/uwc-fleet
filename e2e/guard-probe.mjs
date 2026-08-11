/**
 * BROWSER PROOF of the POD outbox erase guard — the negative control and the
 * positive one, run against whatever build is currently served.
 *
 * TO RE-PROVE IT, put the break back. In lib/podOutbox.ts, first line inside
 * flushPodOutbox's `try {`:
 *
 *     await writeOutbox([]);   // a conclusion the caller never earned
 *
 * That is the exact shape that has now produced three defects ("I read
 * nothing" → "there is nothing" → written back). Then, from mobile/:
 *
 *   EXPO_PUBLIC_API_URL=http://localhost:3000 npm run build:web
 *   node ../e2e/guard-probe.mjs "break, guard REMOVED"   # comment the guard call out
 *   node ../e2e/guard-probe.mjs "break, guard PRESENT"   # put it back
 *
 * Verified 12 Aug 2026:
 *   guard REMOVED → queued POD DESTROYED, 0 refusals   (the break is real)
 *   guard PRESENT → queued POD SURVIVED,  1 refusal naming stop s-A
 *
 * Both halves matter. A break that does no damage reads exactly like a proven
 * guard, and unit tests were green through all three instances of this shape,
 * so the proof has to be here — in the browser, on the served bundle.
 */
import { chromium } from "@playwright/test";

const WEB = "http://localhost:8081";
const A = { phone: "100000101", pw: "Password123" };
const LABEL = process.argv[2] ?? "(unlabelled build)";

const served = (await (await fetch(`${WEB}/BUILD_SHA`)).text()).trim();
console.log(`\n=== ${LABEL} ===`);
console.log(`served build: ${served}`);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const warnings = [];
page.on("console", (m) => {
  if (/refusing to empty/i.test(m.text())) warnings.push(m.text());
});

const outbox = (page, id) =>
  page.evaluate((k) => localStorage.getItem(k), `uwc.u.${id}.podOutbox`);

try {
  // 1. Sign in for real, then queue a POD through the storage layer.
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.locator('input[type="tel"]').first().fill(A.phone);
  await page.getByPlaceholder(/enter your password/i).first().fill(A.pw);
  await page.getByText(/^Sign In$/).first().click();
  await page.waitForTimeout(5000);

  const aId = await page.evaluate(() => localStorage.getItem("uwc.activeUserId"));
  if (!aId) throw new Error("no active user — sign-in did not complete");

  await page.evaluate((id) => {
    localStorage.setItem(
      `uwc.u.${id}.podOutbox`,
      JSON.stringify([
        {
          tripId: "t-A", stopId: "s-A",
          photo: { uri: "data:image/jpeg;base64,AAAA", name: "pod.jpg", type: "image/jpeg" },
          photoUploaded: false, markArrived: false, arrivedMarked: false,
          photoCapturedAt: null, k2FormAck: false, k2Acked: false,
          confirmDelivered: true, queuedAt: new Date().toISOString(), apiFailures: 0,
        },
      ])
    );
  }, aId);
  console.log(`queued a POD under ${aId}`);

  // 2. Reload with the TRIP endpoints unreachable, so the flush cannot
  //    legitimately resolve the item — anything that empties the queue now is
  //    the bug and not the server. (Blocking only /trips/, rather than taking
  //    the whole context offline, keeps sign-in restorable and the page
  //    loadable; the last diagnostic showed a fabricated trip id being dropped
  //    on a 404, which is exactly the confusion this avoids.)
  await page.route("**/api/v1/trips/**", (r) => r.abort());
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);

  const after = await outbox(page, aId);
  const parsed = after ? JSON.parse(after) : null;
  const survived = Array.isArray(parsed) && parsed.length === 1;
  console.log(`outbox after the flush ran: ${after === null ? "KEY GONE" : after.slice(0, 45) + "…"}`);
  console.log(`>> queued POD ${survived ? "SURVIVED" : "DESTROYED"}`);
  console.log(`>> guard refusals seen in console: ${warnings.length}`);
  for (const w of warnings.slice(0, 2)) console.log(`     ${w.slice(0, 130)}`);
} catch (err) {
  console.log(`!! ${err.message.split("\n")[0]}`);
} finally {
  await browser.close();
}
