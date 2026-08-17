import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

/**
 * Locale parity: en.json, ms.json and zh.json must carry the SAME key set.
 *
 * i18next silently falls back to English for a missing key, so an en-only string
 * is invisible in testing and only bites the Malay/Chinese driver in the field.
 * That is how the entire `exception.*` namespace (60 keys) and these 22 admin
 * plural variants sat missing for weeks — nobody looks at key counts.
 *
 * AGENTS.md already requires every new string to land in all three files. This
 * test is what makes that rule enforceable instead of aspirational.
 *
 * NOTE ON PLURALS: `compatibilityJSON: "v4"` (see index.ts) means i18next uses
 * CLDR categories. Malay and Chinese each have only `other`, so their `_one` and
 * `_other` entries legitimately carry identical text — the point is that the KEY
 * exists, so lookup never falls through to English.
 */

const DIR = __dirname;
const LOCALES = ["en", "ms", "zh"] as const;

type Flat = Record<string, string>;

function flatten(value: unknown, prefix = "", out: Flat = {}): Flat {
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const loaded = Object.fromEntries(
  LOCALES.map((l) => [l, flatten(JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), "utf8")))])
) as Record<(typeof LOCALES)[number], Flat>;

describe("i18n locale parity", () => {
  /**
   * ⚠ NON-VACUITY FIRST — every test below walks en's key list, so an en.json
   * that failed to load or flatten would make all of them pass while checking
   * nothing. This is the mechanism that made the e2e selector-drift guard
   * useless (17 Aug 2026): a check BUILT FROM the data it checks degrades to
   * accepting everything and reports it as success.
   *
   * The floor is deliberately a real number rather than > 0: a flatten bug that
   * returned one key would otherwise still pass.
   */
  it("actually loaded all three locales", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(loaded[locale]).length, `${locale}.json looks empty`).toBeGreaterThan(1_000);
    }
  });

  it("ms and zh define every key en defines", () => {
    const en = Object.keys(loaded.en);
    const missing: string[] = [];
    for (const locale of ["ms", "zh"] as const) {
      for (const key of en) {
        if (!(key in loaded[locale])) missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("ms and zh define no key en does not", () => {
    // An orphan key is dead weight, and usually a rename that only landed in one file.
    const en = new Set(Object.keys(loaded.en));
    const orphans: string[] = [];
    for (const locale of ["ms", "zh"] as const) {
      for (const key of Object.keys(loaded[locale])) {
        if (!en.has(key)) orphans.push(`${locale}: ${key}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("a key with plural variants has both _one and _other in every locale", () => {
    const incomplete: string[] = [];
    for (const locale of LOCALES) {
      const keys = Object.keys(loaded[locale]);
      for (const key of keys) {
        if (!key.endsWith("_one")) continue;
        const other = `${key.slice(0, -"_one".length)}_other`;
        if (!keys.includes(other)) incomplete.push(`${locale}: ${key} has no ${other}`);
      }
    }
    expect(incomplete).toEqual([]);
  });

  it("no locale leaves a value empty", () => {
    const blank: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(loaded[locale])) {
        if (value.trim() === "") blank.push(`${locale}: ${key}`);
      }
    }
    expect(blank).toEqual([]);
  });

  it("every locale interpolates the same variables for a given key", () => {
    // A dropped {{count}} renders as a sentence with a hole in it, in exactly the
    // language nobody on the team reads.
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const mismatched: string[] = [];
    for (const [key, enValue] of Object.entries(loaded.en)) {
      const expected = vars(enValue);
      for (const locale of ["ms", "zh"] as const) {
        const value = loaded[locale][key];
        if (value === undefined) continue; // covered by the parity test above
        const got = vars(value);
        if (got.join(",") !== expected.join(",")) {
          mismatched.push(`${locale}: ${key} — en {${expected}} vs {${got}}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});
