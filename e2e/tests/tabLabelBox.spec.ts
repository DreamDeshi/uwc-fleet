import { test, expect } from "@playwright/test";
import { ADMIN, DRIVER, REQUESTOR, MOBILE_URL, type Account } from "../helpers/accounts";
import { login, setLanguage } from "../helpers/api";
import { mobileLogin } from "../helpers/ui";

/**
 * REGRESSION GUARD: the bottom tab labels must not be clipped by their own box.
 *
 * Found 4 Aug 2026 on all three roles, all three languages, every phone width:
 * RN-Web renders the 12px label into an 11px box carrying `overflow: hidden`
 * (its numberOfLines implementation), so the glyphs were sliced 5px from the
 * bottom — "Trips" read as "Trins" and "My Stats" lost the tail of its y.
 *
 * ⚠ The obvious fixes do not work and this test exists partly to stop someone
 * re-trying them: the label carries RN-Web's `display: inline` Text class, so
 * `height` is ignored outright, and `overflow: visible` clears the clip only by
 * discarding the ellipsis that keeps a long Malay label off the next tab.
 * `minHeight` is what actually sizes the box. See navigation/DriverTabs.tsx.
 *
 * Measured rather than eyeballed: a screenshot of a 5px slice is exactly the
 * kind of thing that looks fine at thumbnail size.
 */

const ROLES: { name: string; account: Account; labels: Record<string, string[]> }[] = [
  {
    name: "driver",
    account: DRIVER,
    labels: { en: ["Home", "Trips", "My Stats", "Profile"] },
  },
  {
    name: "requestor",
    account: REQUESTOR,
    labels: { en: ["Home", "Bookings", "Insights", "Profile"] },
  },
  {
    name: "admin",
    account: ADMIN,
    labels: { en: ["Home", "Trips", "Fleet", "Settings"] },
  },
];

const WIDTHS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "360x800", width: 360, height: 800 },
];

for (const role of ROLES) {
  test(`${role.name}: bottom tab labels are not clipped`, async ({ page }) => {
    test.setTimeout(180_000);
    const { accessToken } = await login(role.account);
    await setLanguage(accessToken, "en");

    const problems: string[] = [];

    for (const size of WIDTHS) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(MOBILE_URL);
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.reload();
      await mobileLogin(page, role.account);
      await page.waitForTimeout(2500);

      const measured = await page.evaluate((wanted: string[]) => {
        const out: { text: string; clientHeight: number; scrollHeight: number }[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
          if (el.childElementCount !== 0) continue;
          const t = (el.textContent || "").trim();
          if (!wanted.includes(t)) continue;
          if (el.getBoundingClientRect().top < window.innerHeight - 140) continue; // tab bar only
          out.push({ text: t, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight });
        }
        return out;
      }, role.labels.en);

      expect(measured.length, `${role.name}/${size.name}: found no tab labels to measure`).toBeGreaterThan(0);

      for (const m of measured) {
        const clipped = m.scrollHeight - m.clientHeight;
        if (clipped > 0) {
          problems.push(
            `${role.name}/${size.name}: "${m.text}" clipped by ${clipped}px (box ${m.clientHeight}px, glyphs ${m.scrollHeight}px)`
          );
        }
      }
    }

    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });
}
