import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { formatPalletSpaces } from "./pallets";

/**
 * The defect: the dispatch board rendered a real load as "5.875 pallets".
 * Display-only formatting — the stored value and every capacity comparison keep
 * full precision.
 */
describe("formatPalletSpaces", () => {
  it("prints whole numbers bare, with no trailing .0", () => {
    expect(formatPalletSpaces(6)).toBe("6");
    expect(formatPalletSpaces(0)).toBe("0");
    expect(formatPalletSpaces(1)).toBe("1");
  });

  it("prints a fraction to one decimal", () => {
    expect(formatPalletSpaces(5.875)).toBe("5.9");
    expect(formatPalletSpaces(5.9375)).toBe("5.9");
    expect(formatPalletSpaces(3.125)).toBe("3.1");
    expect(formatPalletSpaces(0.5625)).toBe("0.6");
  });

  /**
   * ⚠ THE ORDERING CASE. 5.95 is not an integer, but ROUNDED to one decimal it
   * is 6 — and must print "6", not "6.0". Checking Number.isInteger on the raw
   * value gets this wrong, which is why the check happens after the rounding.
   */
  it("rounds first, then decides whether it is whole", () => {
    expect(formatPalletSpaces(5.95)).toBe("6");
    expect(formatPalletSpaces(1.999)).toBe("2");
    expect(formatPalletSpaces(0.04)).toBe("0");
  });

  it("never returns NaN or Infinity to a text node", () => {
    expect(formatPalletSpaces(NaN)).toBe("0");
    expect(formatPalletSpaces(Infinity)).toBe("0");
  });

  /**
   * The smallest real footprint is 1×1 = 1/16 = 0.0625. It rounds up to 0.1,
   * which overstates a single box — accepted deliberately: one decimal was the
   * ruling, 1×1 is a DEPRECATED footprint that no new booking can select, and
   * "0.1 pallet spaces" still reads as "almost nothing", which is the point.
   */
  it("shows the smallest legacy footprint as 0.1, not as 0", () => {
    expect(formatPalletSpaces(0.0625)).toBe("0.1");
  });
});

/**
 * ⚠ THE GUARD THAT MATTERS. The formatter is easy; remembering it at the
 * fourteenth call site is not. "5.875 pallets" reached a screenshot because the
 * value was rendered raw in one place, and nothing in this repo could tell.
 *
 * So: find every call to a pallet-QUANTITY string and assert it goes through
 * formatPalletSpaces. Prove it by deleting the formatter from any one call site
 * and watching this go red — that is the failure this exists for, not a bug in
 * the arithmetic.
 *
 * NOT covered on purpose: `analytics.totalPallets`. The API builds it by summing
 * `c.quantity` (routes/analytics.ts), so it is a COUNT of pallets shipped, not
 * 4x4-equivalent deck space. It is an integer and it is a different unit, which
 * is why it still reads "pallets" while everything else reads "pallet spaces".
 */
describe("every pallet quantity on screen goes through the formatter", () => {
  const QUANTITY_KEYS = [
    "driver.palletCount",
    "driver.ladderLoaded",
    "driver.ladderPickup",
    "history.palletCount",
    "booking.totalPallets",
    "booking.largeLoadWarning",
    "admin.trips.palletsShort",
    "admin.trips.showingDrivers",
    "admin.trucks.palletsCount",
    "admin.dashboard.loadPallets",
  ];

  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
    });

  it("passes a formatted string, never the raw number", () => {
    const SRC = path.resolve(__dirname, "..");
    const files = walk(SRC).filter((f) => !f.includes(`${path.sep}i18n${path.sep}`));

    // POSITIVE CONTROL — a walk that visited nothing yields no offenders, which
    // is indistinguishable from a clean sweep.
    expect(files.length, "source walk visited nothing").toBeGreaterThan(100);

    const offenders: string[] = [];
    let callsChecked = 0;

    for (const file of files) {
      const src = codeOnly(fs.readFileSync(file, "utf-8"));
      for (const key of QUANTITY_KEYS) {
        // indexOf, not a RegExp: this guard was written with a template-literal
        // pattern whose backslashes were eaten before it reached disk, so it
        // compiled to `t(s*"key"...)` and matched NOTHING. The offender list
        // was empty and the test passed. Only the callsChecked control below
        // caught it. Escape-free scanning cannot fail that way.
        const needle = 't("' + key + '"';
        let at = src.indexOf(needle);
        while (at !== -1) {
          callsChecked++;
          const call = src.slice(at, at + 220);
          if (!call.includes("formatPalletSpaces")) {
            offenders.push(path.relative(SRC, file) + " :: " + call.slice(0, 90));
          }
          at = src.indexOf(needle, at + needle.length);
        }
      }
    }

    // SECOND POSITIVE CONTROL — if the regex stopped matching (a rename, a
    // reformat), callsChecked drops to 0 and the offender list is empty for the
    // wrong reason.
    expect(callsChecked, "matched no pallet call sites at all").toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });
});
