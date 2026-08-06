import { test, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { ADMIN, DRIVER, REQUESTOR, MOBILE_URL, type Account } from "../helpers/accounts";
import { login, setLanguage } from "../helpers/api";
import { mobileLogin } from "../helpers/ui";
import en from "../../mobile/src/i18n/en.json";
import ms from "../../mobile/src/i18n/ms.json";
import zh from "../../mobile/src/i18n/zh.json";

/**
 * VISUAL AUDIT SWEEP — the eyes-on companion to i18nLayoutSweep.
 *
 * i18nLayoutSweep proves three things that are cheap to assert: the page never
 * scrolls sideways, no raw i18n key reaches the screen, and every tab label
 * translates well enough to be clickable. All three can pass on a screen that
 * still looks broken, because the failures that survive them are LOCAL:
 *
 *   - a label clipped inside its own box (the row fits; the text does not)
 *   - a control pushed under the tab bar or off the bottom of the viewport
 *   - an empty state that renders as a bare void with no message
 *
 * So this spec does two things the other cannot: it SAVES a screenshot of every
 * screen in every language at both widths, and it walks the DOM for elements
 * whose content overflows their own box or whose hit area sits outside the
 * viewport. It asserts nothing — it writes `ui-audit-findings.json` and the
 * PNGs, for a human (or the agent driving it) to read. A sweep that fails the
 * run would stop at the first screen; this one has to see all of them.
 */

const LOCALES = { en, ms, zh } as const;
type Lang = keyof typeof LOCALES;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const OUT = path.resolve(__dirname, "../screenshots/ui-audit");

const ROLES: { name: string; account: Account; phone: string[]; desktop: string[] }[] = [
  {
    name: "driver",
    account: DRIVER,
    phone: ["tabs.home", "tabs.trips", "tabs.myStats", "tabs.profile"],
    desktop: ["tabs.home", "tabs.trips", "tabs.myStats", "tabs.profile"],
  },
  {
    name: "requestor",
    account: REQUESTOR,
    phone: ["tabs.home", "tabs.bookings", "tabs.analytics", "tabs.profile"],
    desktop: ["tabs.home", "tabs.newBooking", "tabs.bookings", "tabs.analytics", "tabs.profile"],
  },
  {
    name: "admin",
    account: ADMIN,
    phone: ["admin.tabs.home", "admin.tabs.trips", "admin.tabs.fleet"],
    desktop: [
      "admin.nav.dashboard",
      "admin.nav.trips",
      "admin.nav.incentiveApprovals",
      "admin.nav.drivers",
      "admin.nav.trucks",
      "admin.nav.incentives",
      "admin.nav.consignees",
      "admin.nav.reports",
      "admin.nav.sustainability",
      "admin.nav.settings",
    ],
  },
];

function copy(lang: Lang, p: string): string {
  const v = p.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], LOCALES[lang]);
  if (typeof v !== "string") throw new Error(`${lang}: no string at ${p}`);
  return v;
}

interface Finding {
  screen: string;
  kind:
    | "clipped-text"
    | "offscreen-control"
    | "zero-size-control"
    | "empty-screen"
    | "container-overflow"
    | "sibling-height-mismatch";
  detail: string;
  text?: string;
}

/**
 * Walk the rendered DOM for local breakage.
 *
 * CLIPPED TEXT: a leaf element whose scrollWidth/scrollHeight exceeds its own
 * client box while overflow is hidden/clipped or text-overflow is ellipsis.
 * That is text the user cannot read, and it never widens the page — which is
 * exactly why the overflow assertion in the other sweep cannot see it. A 1px
 * slack absorbs sub-pixel rounding in RN-web's flex maths.
 *
 * OFFSCREEN / ZERO-SIZE CONTROL: RN-web renders pressables as divs, so the only
 * reliable signal that something is interactive is `cursor: pointer`. A control
 * whose box has no area, or which sits outside the viewport horizontally (or
 * below the fold on a screen that does not scroll), cannot be tapped.
 *
 * CONTAINER OVERFLOW: a child wider than its parent's content box, where the
 * parent does not scroll so the overflow has nowhere to go.
 *
 * ⚠ It does NOT catch the `width: "48.9%"` + `gap: 16` fault the admin grids
 * shipped, and it was a mistake to think it would. Measured in a browser: at a
 * 700px container those cards do not overflow at all — flex-wrap sends the
 * second one to its own row, so the grid silently collapses from two columns
 * to one. Premature WRAPPING, not overflow. That symptom has no reliable
 * signature in the DOM (a wrapped row is normally correct), so it stays a
 * human-review finding. The detector is kept because a child genuinely
 * spilling a non-scrolling parent is still a bug — just not that one.
 *
 * SIBLING HEIGHT MISMATCH: cards in one wrapping flex row whose heights differ.
 * Added after unbounded driver names ("Muhamad Zulkhairi Bin Yusuf" wraps to
 * three lines in a narrow stat cell) made one card taller than its neighbour
 * and threw the grid out of alignment. Every earlier detector passed it —
 * nothing was clipped, hidden or unreachable; the row was merely misaligned,
 * which is precisely the class no assertion here could see.
 *
 * ⚠ Only as good as the DATA. The demo/test seed uses "Driver 1"…"Driver 8",
 * which never wrap, so a sweep against placeholder names will NOT reproduce
 * this. Run it against realistic long names — that is the condition that hid
 * the class for three weeks.
 */
async function auditDom(page: Page, screen: string): Promise<Finding[]> {
  return page.evaluate((screenName) => {
    const out: Finding[] = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrollable = document.documentElement.scrollHeight > vh + 2;

    const trim = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);

    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
      const rect = el.getBoundingClientRect();

      // — clipped text (leaf nodes only, so we blame the box that actually clips)
      const isLeaf = el.childElementCount === 0;
      const text = (el.textContent || "").trim();
      if (isLeaf && text) {
        const clipsX = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis";
        const clipsY = cs.overflowY === "hidden" || cs.overflowY === "clip";
        if (clipsX && el.scrollWidth > el.clientWidth + 1) {
          out.push({
            screen: screenName,
            kind: "clipped-text",
            detail: `horizontally clipped: content ${el.scrollWidth}px in ${el.clientWidth}px box`,
            text: trim(text),
          });
        } else if (clipsY && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
          out.push({
            screen: screenName,
            kind: "clipped-text",
            detail: `vertically clipped: content ${el.scrollHeight}px in ${el.clientHeight}px box`,
            text: trim(text),
          });
        }
      }

      // — a child spilling out of its parent's content box
      // Guarded on the PARENT clipping or the child genuinely sticking out:
      // an intentionally scrollable container (overflow:auto/scroll) is not a
      // bug, so only report where the overflow has nowhere to go.
      const parent = el.parentElement;
      if (parent && rect.width > 0) {
        const pcs = getComputedStyle(parent);
        const prect = parent.getBoundingClientRect();
        const parentScrollsX = pcs.overflowX === "auto" || pcs.overflowX === "scroll";
        const spill = Math.round(rect.right - prect.right);
        if (!parentScrollsX && prect.width > 0 && spill > 1 && cs.position !== "fixed" && cs.position !== "absolute") {
          out.push({
            screen: screenName,
            kind: "container-overflow",
            detail: `overflows its parent by ${spill}px (child ${Math.round(rect.width)}px in ${Math.round(prect.width)}px box)`,
            text: trim(text),
          });
        }
      }

      // — controls that cannot be reached
      if (cs.cursor === "pointer" && text) {
        if (rect.width === 0 || rect.height === 0) {
          out.push({
            screen: screenName,
            kind: "zero-size-control",
            detail: `control has no hit area (${Math.round(rect.width)}x${Math.round(rect.height)})`,
            text: trim(text),
          });
        } else if (rect.left < -1 || rect.right > vw + 1) {
          out.push({
            screen: screenName,
            kind: "offscreen-control",
            detail: `control is outside the viewport horizontally (x ${Math.round(rect.left)}..${Math.round(rect.right)} in ${vw}px)`,
            text: trim(text),
          });
        } else if (!scrollable && rect.bottom > vh + 1) {
          out.push({
            screen: screenName,
            kind: "offscreen-control",
            detail: `control sits below the fold on a screen that does not scroll (bottom ${Math.round(rect.bottom)} > ${vh})`,
            text: trim(text),
          });
        }
      }
    }

    // — cards in one wrapping row that do not share a height
    //
    // Per-CONTAINER, not per-element: the fault is a relationship between
    // siblings, which is why every element-at-a-time detector above walked
    // straight past it. Only wrapping flex rows are considered — that is the
    // card-grid shape — and only children that actually share a row (same top,
    // within 2px), because items on different rows are supposed to differ.
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const rcs = getComputedStyle(row);
      if (rcs.display !== "flex" || rcs.flexWrap !== "wrap" || rcs.flexDirection !== "row") continue;
      const kids = Array.from(row.children) as HTMLElement[];
      if (kids.length < 2) continue;

      // ⚠ Measure the CARD, not the flex item. A wrapping row defaults to
      // align-items: stretch, so the direct children are ALWAYS equal height —
      // measuring them means this detector can never fire. The visible
      // misalignment is the card INSIDE the stretched wrapper, which takes its
      // content height. Verified: wrappers 69/69 while the cards were 53/69.
      const inner = (k: HTMLElement): HTMLElement => {
        let cur = k;
        while (cur.childElementCount === 1) cur = cur.firstElementChild as HTMLElement;
        return cur;
      };

      const boxes = kids
        .map((k) => {
          const el = inner(k);
          return { el, r: el.getBoundingClientRect() };
        })
        .filter((b) => b.r.width > 0 && b.r.height > 0);

      const byRow = new Map<number, { el: HTMLElement; r: DOMRect }[]>();
      for (const b of boxes) {
        const key = Math.round(b.r.top / 2) * 2;
        const bucket = byRow.get(key) ?? [];
        bucket.push(b);
        byRow.set(key, bucket);
      }

      for (const bucket of byRow.values()) {
        if (bucket.length < 2) continue;
        const heights = bucket.map((b) => b.r.height);
        const min = Math.min(...heights);
        const max = Math.max(...heights);
        // 4px absorbs sub-pixel flex rounding; anything more is a real
        // difference a reader will see as misalignment.
        if (max - min > 4) {
          const tallest = bucket.find((b) => b.r.height === max)!;
          out.push({
            screen: screenName,
            kind: "sibling-height-mismatch",
            detail: `${bucket.length} cards share a row but differ in height by ${Math.round(max - min)}px (${Math.round(min)}..${Math.round(max)})`,
            text: trim(tallest.el.textContent || ""),
          });
        }
      }
    }

    // — a screen with almost no text at all is very likely a broken empty state
    const bodyText = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    if (bodyText.length < 20) {
      out.push({
        screen: screenName,
        kind: "empty-screen",
        detail: `screen renders almost no text (${bodyText.length} chars) — blank or failed render`,
        text: bodyText,
      });
    }

    // de-duplicate identical (kind, text, detail) triples from repeated rows
    const seen = new Set<string>();
    return out.filter((f) => {
      const k = `${f.kind}|${f.text}|${f.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, screen);
}

const findings: Finding[] = [];

test.afterAll(async () => {
  for (const { account } of ROLES) {
    try {
      const { accessToken } = await login(account);
      await setLanguage(accessToken, "en");
    } catch {
      /* best effort */
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "ui-audit-findings.json"), JSON.stringify(findings, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nUI AUDIT: ${findings.length} finding(s) across the sweep. PNGs + JSON in ${OUT}\n`);
});

for (const { name, account, ...nav } of ROLES) {
  for (const [layout, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    const tabKeys = nav[layout];
    test(`capture ${name} — ${layout}`, async ({ page }) => {
      test.setTimeout(300_000);
      fs.mkdirSync(OUT, { recursive: true });

      for (const lang of Object.keys(LOCALES) as Lang[]) {
        const { accessToken } = await login(account);
        await setLanguage(accessToken, lang);

        await page.setViewportSize(viewport);
        await page.goto(MOBILE_URL);
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await page.reload();
        await mobileLogin(page, account);

        for (const key of tabKeys) {
          const label = copy(lang, key);
          const tab = page.getByText(label, { exact: true }).locator("visible=true").first();
          try {
            await tab.click({ timeout: 15_000 });
          } catch {
            findings.push({
              screen: `${name}/${layout}/${lang}/${key}`,
              kind: "offscreen-control",
              detail: `tab "${label}" could not be clicked`,
            });
            continue;
          }
          await page.waitForTimeout(1200); // RN-web enter animation + first fetch

          const screen = `${name}/${layout}/${lang}/${key.split(".").pop()}`;
          findings.push(...(await auditDom(page, screen)));
          await page.screenshot({
            path: path.join(OUT, `${name}-${layout}-${lang}-${key.split(".").pop()}.png`),
            fullPage: false,
          });
        }
      }
    });
  }
}
