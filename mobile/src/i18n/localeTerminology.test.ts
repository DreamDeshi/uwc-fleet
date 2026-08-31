import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

/**
 * ONE CONCEPT, ONE WORD, PER LOCALE (AGENTS.md). localeParity.test.ts proves
 * every locale has the same KEYS; it says nothing about whether a locale uses
 * the same WORD for the same concept across different keys — that is a
 * wording bug, not a missing/orphan key, and parity + selector-drift guards
 * both pass right through it.
 *
 * Found in code review 31 Aug 2026: zh.json used 交付 for "delivery" in
 * exactly two live-rendered strings (`podApprovals`, in AdminAlertsBell.tsx;
 * `productivityHint`, in PerformanceScreen.tsx) while every other
 * delivery-related key (statusDelivered, markDelivered, deliveredMeta, and
 * ~40 more) used 送达 or 送货 — the same shape as the already-documented
 * 送达/签收 POD-terminology collision and the tabs.bookings/requestor.book
 * 预订 collision. A Chinese-reading admin would see two different words for
 * the same concept across screens they'd plausibly view in one session.
 *
 * This guard is deliberately NARROW — a real "detect any inconsistent
 * synonym pair" checker needs a concept→word map this repo does not have,
 * and building a broad one risks the same failure class as the vacuous
 * selector-drift regex (a check built from the data it's checking, that
 * degrades to accepting everything). Instead this pins the SPECIFIC word
 * that was found to be the odd one out, with zero legitimate uses anywhere
 * in the file — proven by the fact that removing both offending strings
 * during the fix left zero remaining matches.
 */
describe("zh.json delivery terminology — 交付 must not reappear", () => {
  const zhRaw = fs.readFileSync(path.join(__dirname, "zh.json"), "utf8");

  it("⚠ NON-VACUITY FIRST — the file actually loaded and is not suspiciously short", () => {
    expect(zhRaw.length).toBeGreaterThan(10_000);
  });

  it("has zero uses of 交付 — every delivery concept already has an established word (送达/送货)", () => {
    const matches = zhRaw.match(/交付/g) ?? [];
    expect(matches, "交付 reappeared — check it isn't reintroducing the podApprovals/productivityHint collision").toHaveLength(0);
  });

  it("the established words are actually present and load-bearing, not just absent-by-coincidence", () => {
    // Guards against a fix that also accidentally deleted the correct terms —
    // an empty file would pass the test above for the wrong reason.
    expect((zhRaw.match(/送达/g) ?? []).length).toBeGreaterThan(20);
    expect((zhRaw.match(/送货/g) ?? []).length).toBeGreaterThan(10);
  });
});
