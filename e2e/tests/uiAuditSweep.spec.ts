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
  kind: "clipped-text" | "offscreen-control" | "zero-size-control" | "empty-screen";
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
