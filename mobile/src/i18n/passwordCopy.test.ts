import fs from "node:fs";
import path from "node:path";

import i18next from "i18next";
import { describe, it, expect } from "vitest";

import { PASSWORD_MIN_LENGTH } from "../lib/passwordPolicy";

/**
 * The password floor appears in USER-FACING COPY in three locales. This test
 * exists because of the specific way that copy goes stale: the constant moves,
 * en.json gets edited, and ms/zh keep promising the old number to the only users
 * who read them.
 *
 * The floor has now moved three times (12 → 11 on 4 Aug 2026, 11 → 8 on 11 Aug
 * 2026 at the client's request). Each move is a chance for one locale to be
 * missed, and `localeParity.test.ts` cannot catch it — the KEY is present in all
 * three files, it is the NUMBER inside the value that is wrong. Nothing else
 * looks at that number.
 *
 * So the copy no longer states the floor at all: it interpolates `{{count}}`
 * from PASSWORD_MIN_LENGTH, and this test proves the interpolation actually
 * happens and that no locale smuggles a second number in beside it.
 *
 * ⚠ WHY IT ASSERTS ON *EVERY* DIGIT RATHER THAN JUST "contains 8". A stale
 * sentence reading "at least 11 characters" for a floor of 8 would still
 * contain an 8 if someone interpolated it into an unedited string. Requiring
 * the floor to be the ONLY number present is what makes a leftover literal
 * fail.
 *
 * ⚠ `{{count}}` IS NOT A PLAIN VARIABLE TO i18next. Passing `count` triggers
 * CLDR plural resolution (`compatibilityJSON: "v4"`, see index.ts): lookup tries
 * `key_one`/`key_other` first and only then the bare key. These keys have no
 * plural forms, so they rely on that final fallback — which is exactly the kind
 * of thing that works until an i18next upgrade quietly changes it. Rendering
 * through a real i18next instance is the point; a test that only read the JSON
 * would pass while the app displayed a raw `{{count}}`.
 */

const DIR = __dirname;
const LOCALES = ["en", "ms", "zh"] as const;

// Every key whose text states the password floor. A new one belongs here.
const KEYS_STATING_THE_FLOOR = ["common.passwordTooWeak", "register.passwordPlaceholder"];

// Mirrors the init options in index.ts. Built standalone rather than importing
// that module, which pulls in expo-localization for device-language detection.
const i18n = i18next.createInstance();
i18n.init({
  resources: Object.fromEntries(
    LOCALES.map((l) => [
      l,
      { translation: JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), "utf8")) },
    ])
  ),
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  compatibilityJSON: "v4",
});

describe("password floor copy", () => {
  for (const locale of LOCALES) {
    for (const key of KEYS_STATING_THE_FLOOR) {
      it(`${locale}: ${key} states the floor and no other number`, async () => {
        await i18n.changeLanguage(locale);
        const text = i18n.t(key, { count: PASSWORD_MIN_LENGTH });

        // The interpolation ran at all — a plural-lookup miss leaves the raw
        // placeholder sitting in the sentence the user reads.
        expect(text, `${locale}/${key} did not interpolate`).not.toContain("{{");

        // The floor is the only number in the sentence.
        expect(text.match(/\d+/g) ?? [], `${locale}/${key}: "${text}"`).toEqual([
          String(PASSWORD_MIN_LENGTH),
        ]);
      });
    }
  }

  // Guards the guard: if a key were renamed away, `t()` returns the key itself
  // and every assertion above would still pass on a string with no digits at
  // all. This is the assertion that would go red for a missing key.
  it("every key it checks actually resolves to real copy", async () => {
    await i18n.changeLanguage("en");
    for (const key of KEYS_STATING_THE_FLOOR) {
      expect(i18n.t(key, { count: PASSWORD_MIN_LENGTH }), key).not.toBe(key);
    }
  });
});
