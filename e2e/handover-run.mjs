/**
 * DG-D4 MANUAL HANDOVER RUN — the shared-handset check no test suite can make.
 *
 * Drives the SERVED WEB BUILD (what the trial actually runs) through a real
 * driver handover and reports what storage actually holds at each step.
 *
 *   npm run build:web            # in mobile/ — writes dist/BUILD_SHA
 *   PORT=8081 node serve.mjs     # in mobile/
 *   node handover-run.mjs        # here
 *
 * It OBSERVES and reports; it does not assert-pass. The point is to find out
 * what happens, not to confirm what someone expected.
 */
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";

const WEB = "http://localhost:8081";
const A = { phone: "100000101", pw: "Password123", label: "driver A" };
const B = { phone: "100000102", pw: "Password123", label: "driver B" };

/**
 * BUILD-FRESHNESS GATE — runs before any scenario and REFUSES to proceed.
 *
 * Twice on 12 Aug 2026 a manual run nearly produced a wrong conclusion against a
 * stale bundle: once a build two days old (serve.mjs hardcodes ./dist and
 * silently ignores a directory argument), once an export taken before the very
 * fix under test. Both were caught only by remembering to grep the bundle for an
 * expected string — which works only if you think to do it AND pick the right
 * string. That is not a control; it is a habit.
 */
async function assertBuildIsCurrent() {
  const head = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  let served;
  try {
    const res = await fetch(`${WEB}/BUILD_SHA`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    served = (await res.text()).trim();
    // serve.mjs falls back to index.html for unknown paths and returns 200, so
    // "missing BUILD_SHA" arrives as HTML rather than as a 404.
    if (/^</.test(served)) throw new Error("no BUILD_SHA in the export (got the SPA fallback)");
  } catch (err) {
    console.error(
      `\nREFUSING TO RUN: the served build carries no BUILD_SHA (${err.message}).` +
        `\nRebuild with:  npm run build:web    (from mobile/)`
    );
    process.exit(1);
  }
  const [servedSha] = served.split(/\s+/);
  if (servedSha !== head || served.includes("dirty")) {
    console.error(
      `\nREFUSING TO RUN: the served build is not this commit.` +
        `\n  served: ${served}\n  HEAD:   ${head}` +
        `\nRebuild with:  npm run build:web    (from mobile/)`
    );
    process.exit(1);
  }
  console.log(`build freshness: OK (${servedSha.slice(0, 8)} == HEAD)`);
}

const keys = (page) =>
  page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) ?? "";
      out[k] = v.length > 55 ? `${v.slice(0, 55)}…(${v.length}b)` : v;
    }
    return out;
  });

const show = (label, k) => {
  console.log(`\n  ${label}`);
  const e = Object.entries(k).filter(([n]) => /^(uwc|admin|requestor)\./.test(n));
  if (!e.length) console.log("    (no app keys)");
  for (const [n, v] of e.sort()) console.log(`    ${n} = ${v}`);
};

async function login(page, who) {
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.locator('input[type="tel"]').first().fill(who.phone);
  await page.getByPlaceholder(/enter your password/i).first().fill(who.pw);
  await page.getByText(/^Sign In$/).first().click();
  await page.waitForTimeout(5000);
}

/** Profile tab → "Log Out" opens an in-app modal → a SECOND "Log Out" confirms. */
async function logout(page) {
  await page.getByText(/^Profile$/).last().click();
  await page.waitForTimeout(2000);
  await page.getByText(/log out/i).last().click();
  await page.waitForTimeout(1200);
  await page.getByText(/log out/i).last().click();
  await page.waitForTimeout(4500);
}

await assertBuildIsCurrent();

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("dialog", async (d) => {
  console.log(`    [browser dialog] ${d.type()}: ${d.message().slice(0, 110)}`);
  await d.accept();
});

try {
  console.log("\n=== SCENARIO 1 — driver A signs in (REAL UI) ===");
  await login(page, A);
  let k = await keys(page);
  show("after A signs in:", k);
  const aId = k["uwc.activeUserId"];
  console.log(`  >> uwc.activeUserId = ${aId ?? "MISSING"}`);

  // SEEDED, not captured — the camera cannot run headless, so the queued POD is
  // written through the storage layer's key shape rather than the capture UI.
  //
  // ⚠ tripId "t-A" DOES NOT EXIST on the server. That is deliberate and it is
  // why 3b has two phases: once the item reaches the API it is answered with
  // TRIP_NOT_FOUND and dropped as stale, which is correct behaviour and looks
  // identical, in localStorage, to the queue being erased. Do not read an empty
  // array here as either verdict without looking at the wire.
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
  console.log("  >> SEEDED a queued POD under A's namespace (storage layer, NOT the capture UI)");

  console.log("\n=== SCENARIO 2 — A signs out with the network down (REAL UI) ===");
  await ctx.setOffline(true);
  await logout(page);
  await ctx.setOffline(false);
  k = await keys(page);
  show("after A signs out:", k);
  console.log(`  >> A's queued POD kept? ${`uwc.u.${aId}.podOutbox` in k ? "YES" : "NO"}`);
  console.log(`  >> A's tokens cleared? ${"uwc.accessToken" in k ? "NO" : "YES"}`);

  console.log("\n=== SCENARIO 3 — driver B signs in (REAL UI) ===");
  await login(page, B);
  k = await keys(page);
  show("after B signs in:", k);
  const bId = k["uwc.activeUserId"];
  // ⚠ WORD THIS PRECISELY. localStorage has no per-user partition, so A's key is
  // physically PRESENT while B is signed in — that is the direct cost of keeping
  // evidence rather than deleting it. What the app enforces is that B cannot
  // RESOLVE it: every read goes through currentScopedKey, which keys on
  // uwc.activeUserId. Isolation by key resolution, not by absence. The earlier
  // label said "readable under B's session", which claims far more than the run
  // shows and would read as a leak.
  const present = Object.keys(k).filter((n) => aId && n.includes(aId));
  console.log(`  >> A's keys still ON THE DEVICE: ${present.length ? present.join(", ") : "NONE"}`);
  console.log(`  >> B's session points at: ${bId} (${bId === aId ? "⚠ SAME AS A" : "distinct"})`);
  console.log(`  >> what B's app resolves as its outbox: ${k[`uwc.u.${bId}.podOutbox`] ?? "(nothing queued)"}`);

  // ⚠ TWO PHASES, and the first run conflated them. A's queued POD leaving the
  // queue on A's return is only good news if the SERVER took it. Phase i blocks
  // the trip endpoints so nothing can be legitimately resolved — anything that
  // empties the queue there is data loss. Phase ii lets it through and reports
  // what the server actually said, rather than inferring it from an empty array.
  console.log("\n=== SCENARIO 3b(i) — A signs back in, trip endpoints UNREACHABLE (REAL UI) ===");
  await logout(page);
  const block = (route) => route.abort();
  await page.route("**/api/v1/trips/**", block);
  await login(page, A);
  await page.waitForTimeout(2000);
  k = await keys(page);
  show("after A returns (nothing can be resolved):", k);
  const kept3b = k[`uwc.u.${aId}.podOutbox`];
  console.log(`  >> A's queued POD still there? ${kept3b && kept3b !== "[]" ? "YES" : "NO — LOST"}`);

  console.log("\n=== SCENARIO 3b(ii) — the same session reaches the server ===");
  const seen = [];
  const watch = (res) => {
    if (/\/trips\//.test(res.url())) seen.push(`${res.request().method()} ${res.url().split("/api/v1")[1]} -> ${res.status()}`);
  };
  page.on("response", watch);
  await page.unroute("**/api/v1/trips/**", block);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);
  k = await keys(page);
  console.log(`  >> what the server was asked: ${seen.length ? seen.join(" | ") : "(nothing)"}`);
  console.log(`  >> A's outbox now: ${k[`uwc.u.${aId}.podOutbox`] ?? "(key gone)"}`);
  page.off("response", watch);

  console.log("\n=== SCENARIO 4 — legacy global data, NO session (REAL app boot) ===");
  await logout(page);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("uwc.podOutbox", '["LEGACY-ORPHAN-PAYLOAD"]');
    localStorage.setItem("uwc.gpsConsent", "accepted");
  });
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  k = await keys(page);
  show("after booting with no session:", k);
  const orphan = Object.keys(k).filter((n) => n.startsWith("uwc.orphaned."));
  console.log(`  >> quarantined: ${orphan.length ? orphan.join(", ") : "NONE"}`);
  console.log(`  >> still global?  ${"uwc.podOutbox" in k ? "YES" : "NO"}`);
  console.log(
    `  >> payload survives? ${JSON.stringify(k).includes("LEGACY-ORPHAN-PAYLOAD") ? "YES" : "NO — DESTROYED"}`
  );
} catch (err) {
  console.log(`\n!! RUN ERROR: ${err.message.split("\n")[0]}`);
} finally {
  await browser.close();
}
