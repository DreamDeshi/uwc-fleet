import { test, expect, type Page } from "@playwright/test";
import { ADMIN, DRIVER, REQUESTOR, type Account } from "../helpers/accounts";
import { login, setLanguage } from "../helpers/api";
import { mobileLogin } from "../helpers/ui";
import { MOBILE_URL } from "../helpers/accounts";
import en from "../../mobile/src/i18n/en.json";
import ms from "../../mobile/src/i18n/ms.json";
import zh from "../../mobile/src/i18n/zh.json";

/**
 * EVERY SCREEN, EVERY ROLE, BOTH LAYOUTS, ALL THREE LANGUAGES.
 *
 * A breadth sweep rather than a behaviour suite: it walks each role's primary
 * navigation in en / ms / zh at phone and desktop widths and asserts the three
 * things that actually break when copy changes length or a translation is
 * missing.
 *
 *   1. NO HORIZONTAL OVERFLOW. Malay is routinely 20-30% longer than English
 *      and Chinese much shorter; a row that fits in English can push the page
 *      sideways in Malay. The body must never scroll horizontally.
 *   2. NO RAW KEYS ON SCREEN. If a key is missing at runtime, i18next renders
 *      the key itself — "driver.todaysAssignments" in the middle of the UI.
 *      That is invisible to a locale-parity unit test if the key is missing
 *      from the file the test does not read.
 *   3. THE TAB LABELS THEMSELVES TRANSLATE. Navigation is driven by each
 *      locale's OWN label, read from that locale's JSON, so a tab that failed
 *      to translate cannot be clicked and the test fails on it.
 *
 * Language is set through PATCH /users/me (language_pref) rather than by
 * driving the picker: the picker has its own spec, and going through the API
 * keeps this sweep about layout instead of about the switcher.
 */

const LOCALES = { en, ms, zh } as const;
type Lang = keyof typeof LOCALES;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * The primary destinations for each role, as i18n paths into the locale file.
 *
 * Navigation is layout-dependent, not just styled differently: admin collapses
 * to a four-item tab bar (admin.tabs.*) on a phone but presents a full sidebar
 * (admin.nav.*) on a desktop, and the requestor gains a "New Booking" drawer
 * entry that has no phone equivalent. Walking one list at both widths would
 * silently skip whichever surface it does not describe.
 */
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

function copy(lang: Lang, path: string): string {
  const value = path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], LOCALES[lang]);
  if (typeof value !== "string") throw new Error(`${lang}: no string at ${path}`);
  return value;
}

/** i18next renders the key itself when a lookup misses — catch that on screen. */
const RAW_KEY = /\b(?:tabs|trip|driver|admin|requestor|booking|exception|common|profile|earnings|fuel|history|analytics|myPerformance|bookingDetail|login|register|feedback)\.[a-zA-Z][a-zA-Z0-9_]{2,}\b/;

async function auditScreen(page: Page, label: string): Promise<string[]> {
  const problems: string[] = [];

  // 1. horizontal overflow — allow a 2px rounding slack
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, inner: window.innerWidth };
  });
  if (overflow.scroll > overflow.inner + 2) {
    problems.push(`${label}: page scrolls horizontally (${overflow.scroll}px content in ${overflow.inner}px viewport)`);
  }

  // 2. a raw i18n key rendered as visible text
  const body = (await page.locator("body").innerText().catch(() => "")) || "";
  const hit = body.match(RAW_KEY);
  if (hit) problems.push(`${label}: raw i18n key on screen — ${hit[0]}`);

  return problems;
}

for (const { name, account, ...nav } of ROLES) {
  for (const [layout, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    const tabKeys = nav[layout];
    test(`${name} — every screen, ${layout}, all three languages`, async ({ page }) => {
      test.setTimeout(180_000);
      const problems: string[] = [];

      for (const lang of Object.keys(LOCALES) as Lang[]) {
        const { accessToken } = await login(account);
        await setLanguage(accessToken, lang);

        await page.setViewportSize(viewport);
        // The session survives in localStorage, so a second pass would land on
        // Home and never see the login form — and, worse, would still be running
        // the PREVIOUS language, since language_pref is read at login. Clear and
        // reload so each pass is a genuine fresh sign-in in the new language.
        await page.goto(MOBILE_URL);
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await page.reload();
        await mobileLogin(page, account);

        for (const key of tabKeys) {
          const label = copy(lang, key);
          // Pick the VISIBLE match, not the last one. React Navigation keeps the
          // other layout's navigator mounted, so at desktop width the phone
          // home's nav grid still exists in the DOM with pointer-events:none and
          // no bounding box. A .last() lands on that ghost and can never click.
          const tab = page.getByText(label, { exact: true }).locator("visible=true").first();
          try {
            await tab.click({ timeout: 15_000 });
          } catch {
            problems.push(`${lang}/${layout}/${name}: cannot reach "${label}" (${key}) — untranslated or missing`);
            continue;
          }
          await page.waitForTimeout(900); // RN-web enter animation
          problems.push(...(await auditScreen(page, `${lang}/${layout}/${name}/${key}`)));
        }
      }

      expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
    });
  }
}
