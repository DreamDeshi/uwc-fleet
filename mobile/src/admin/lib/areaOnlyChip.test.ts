import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import en from "../../i18n/en.json";
import ms from "../../i18n/ms.json";
import zh from "../../i18n/zh.json";

/**
 * The consignee directory marks rows whose address falls back to the zone
 * centre instead of a real building. At the last production read that was 402
 * of 1,562 active consignees — about one in four, so this is a NORMAL condition
 * and the chip is deliberately quiet.
 *
 * Two things can silently break it, and neither is visible in a diff:
 *
 *  1. the chip drawn on a TRUTHINESS test rather than `=== false`, which makes
 *     an older payload (field absent) look like a positive claim of
 *     area-level — "I don't know" rendered as "I know, and it's coarse";
 *  2. `{{zone}}` losing its interpolation at a call site, which renders the
 *     literal braces to a driver.
 */
const LOCALES = { en, ms, zh } as Record<string, any>;
const countKeys = (o: any): number =>
  Object.values(o).reduce<number>((n, v) => n + (v && typeof v === "object" ? countKeys(v) : 1), 0);

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (rel: string) => codeOnly(fs.readFileSync(path.resolve(__dirname, rel), "utf-8"));

describe("the area-only chip", () => {
  for (const [name, dict] of Object.entries(LOCALES)) {
    it(`${name}: has the chip label, in the consignees namespace`, () => {
      // POSITIVE CONTROL — a locale that failed to load is an empty object and
      // would make every lookup below undefined for the wrong reason.
      expect(countKeys(dict), `${name}.json did not load`).toBeGreaterThan(1000);
      expect(dict.admin?.consignees?.areaOnly, `${name} missing admin.consignees.areaOnly`).toBeTruthy();
      // It landed under admin.users first, where the screen could never reach
      // it — the selector guard caught that, and this keeps it caught.
      expect(dict.admin?.users?.areaOnly, `${name} still has the stray admin.users copy`).toBeUndefined();
    });
  }

  /**
   * ⚠ THE ONE THAT MATTERS. `!c.has_position` and `c.has_position === false`
   * differ only when the field is UNDEFINED — an older client or a payload that
   * predates the field. The first draws the chip and tells the admin this
   * address is coarse; the second stays silent, which is the honest answer when
   * nothing was reported. Prove it by changing the screen to `!c.has_position`.
   */
  it("draws only on an explicit false, never on a missing field", () => {
    const src = read("../screens/ConsigneesScreen.tsx");
    expect(src.length, "ConsigneesScreen moved or was renamed").toBeGreaterThan(2000);
    expect(src, "the chip is not rendered at all").toContain("admin.consignees.areaOnly");
    expect(src, "the chip must test an explicit false").toContain("c.has_position === false");
    expect(src, "a truthiness test would draw the chip on an unknown field").not.toContain(
      "!c.has_position"
    );
  });
});

describe("the approximate-pin line", () => {
  for (const [name, dict] of Object.entries(LOCALES)) {
    it(`${name}: names the zone via interpolation`, () => {
      expect(countKeys(dict), `${name}.json did not load`).toBeGreaterThan(1000);
      expect(dict.trip.approxLocation, `${name} missing trip.approxLocation`).toContain("{{zone}}");
    });
  }

  /**
   * Every call site must pass `zone`, or the driver reads the literal
   * "{{zone}}". Asserted on source because no unit test renders these screens.
   */
  it("every call site supplies the zone", () => {
    const files = [
      "../../screens/driver/ActiveTripScreen.tsx",
      "../../screens/driver/TripDetailsScreen.tsx",
      "../../screens/requestor/BookingDetailScreen.tsx",
    ];
    let found = 0;
    for (const f of files) {
      const src = read(f);
      expect(src.length, `${f} moved or was renamed`).toBeGreaterThan(1000);
      let at = src.indexOf('t("trip.approxLocation"');
      // POSITIVE CONTROL per file — a screen that stopped rendering the line at
      // all would otherwise pass by having nothing to check.
      expect(at, `${f} no longer renders the approximate-pin line`).toBeGreaterThan(-1);
      while (at !== -1) {
        found++;
        expect(src.slice(at, at + 160), `${f} calls it without a zone`).toContain("zone:");
        at = src.indexOf('t("trip.approxLocation"', at + 1);
      }
    }
    expect(found, "matched no call sites at all").toBeGreaterThanOrEqual(3);
  });
});
