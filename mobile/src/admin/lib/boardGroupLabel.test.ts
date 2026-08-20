import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { tripGroup } from "./trip";
import en from "../../i18n/en.json";
import ms from "../../i18n/ms.json";
import zh from "../../i18n/zh.json";

/**
 * The dispatch board's fourth column groups `pending_approval` WITH `completed`
 * — delivered work whose incentive is still waiting on an admin. That grouping
 * is correct and stays: it belongs with completed trips, not with failures.
 *
 * The WORD was wrong. "Completed 5" told an admin that five trips were settled
 * while two of them still needed approving, and approving is where the money
 * moves. "Delivered" is true of all five.
 *
 * ⚠ This is a LABEL fix, not a data one, so the only thing that can regress it
 * is copy — which no other test in this repo reads. Hence these.
 */
const LOCALES = { en, ms, zh } as Record<string, any>;

const countKeys = (o: any): number =>
  Object.values(o).reduce<number>((n, v) => n + (v && typeof v === "object" ? countKeys(v) : 1), 0);

describe("the board's delivered column says Delivered, in every locale", () => {
  for (const [name, dict] of Object.entries(LOCALES)) {
    it(`${name}: the group label is the same word this locale already uses for Delivered`, () => {
      // POSITIVE CONTROL. Every assertion below reads keys out of this object;
      // a locale that failed to load would be an empty object and would satisfy
      // them all vacuously. Establish it is really here first.
      expect(countKeys(dict), `${name}.json did not load`).toBeGreaterThan(1000);

      const label = dict.admin?.trips?.groupDelivered;
      expect(label, `${name} is missing admin.trips.groupDelivered`).toBeTruthy();

      // ONE CONCEPT, ONE WORD, PER LOCALE. `admin.pod.title` vs
      // `bookingDetail.podTitle` drifted to two different Chinese words for
      // Proof of Delivery, and every parity and selector guard passed because
      // those check KEYS, not WORDING. The board's column and the status chip
      // name the same real-world event; they must not diverge.
      expect(label).toBe(dict.trip.statusDelivered);
    });

    it(`${name}: the old groupCompleted key is gone, not left behind`, () => {
      // A retired key that stays in the locale files is how the e2e selector
      // guard was fooled once already: it read en.json, found the string, and
      // approved a selector for copy the app no longer rendered.
      expect(dict.admin?.trips?.groupCompleted).toBeUndefined();
    });
  }
});

describe("the label is REACHED by the board", () => {
  /**
   * ⚠ A correct string nothing renders is the defect this repo keeps shipping.
   * The tests above prove the WORD exists; this one proves the board asks for
   * it. Prove it by pointing GROUP_META's `completed` entry back at
   * `admin.trips.groupCompleted` and watching this go red — not by editing the
   * locale files, which only shows the test can read JSON.
   *
   * Asserted on SOURCE because GROUP_META is a module-private constant in a
   * screen; exporting it purely to test it would be a worse trade.
   *
   * Comments are stripped first. A positive assertion is otherwise satisfied by
   * the comment that MENTIONS the key, so the code could stop using it and this
   * would stay green.
   */
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("GROUP_META maps the completed group to the Delivered label", () => {
    const src = codeOnly(
      fs.readFileSync(path.resolve(__dirname, "../screens/TripsScreen.tsx"), "utf-8")
    );
    expect(src.length, "TripsScreen moved or was renamed").toBeGreaterThan(2000);
    expect(src, "GROUP_META is gone — re-read this guard").toContain("const GROUP_META");

    const meta = src.slice(src.indexOf("const GROUP_META"), src.indexOf("const ZONES"));
    expect(meta.length, "GROUP_META block shape changed").toBeGreaterThan(100);
    expect(meta).toContain("admin.trips.groupDelivered");
    expect(meta, "the retired key is still wired up").not.toContain("admin.trips.groupCompleted");
  });

  it("still folds pending_approval in with completed — the grouping was never the bug", () => {
    expect(tripGroup("pending_approval")).toBe("completed");
    expect(tripGroup("completed")).toBe("completed");
  });
});
