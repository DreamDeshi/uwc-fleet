import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import en from "../../i18n/en.json";
import ms from "../../i18n/ms.json";
import zh from "../../i18n/zh.json";

/**
 * The admin "Formula & Examples" panel — what an admin (and possibly Mr. Teh)
 * reads to understand what the system pays.
 *
 * It had drifted into four money errors while every test stayed green, because
 * nothing checks prose:
 *
 *   · the deduction described as coming off "the first trip of the day"
 *     (pre-aa8d081; it comes off the day TOTAL, once, floored at zero);
 *   · off-peak labelled "Weekend / Holiday", hiding every weekday evening —
 *     which is most of what off-peak actually pays for;
 *   · "Malaysian public holidays", when R1 Q5 named UWC's own Batu Kawan list;
 *   · the 07:00–02:00 PICKUP window quoted as if it were a rate band, and stale
 *     twice over since B6 moved it to midnight.
 *
 * …and the Calculation Rules card rendered EMPTY, because it read an i18n array
 * (`admin.incentives.rules`) that never existed: `t()` returned the key string,
 * `Array.isArray` was false, and the map produced nothing. A card with no
 * content is the same failure family as a guard nothing calls — it looked fine.
 *
 * Two kinds of assertion here, because either alone is weak:
 *   1. RENDER — the panel is rendered against TWO different sets of engine
 *      constants, so a hardcoded "08:00" cannot pass;
 *   2. LOCALE SCAN — the retired claims are absent from all three locale files,
 *      which is the only check that catches a translator putting one back.
 */

(globalThis as any).__DEV__ = false;

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-linear-gradient", async () => {
  const rn = await import("react-native");
  return { LinearGradient: rn.View };
});
vi.mock("@expo/vector-icons", async () => {
  const rn = await import("react-native");
  const React2 = await import("react");
  return { Ionicons: () => React2.createElement(rn.View, null) };
});
vi.mock("../services/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

// The engine constants the panel is being fed. Mutated per test.
const rules = {
  peak_start_hour: 8,
  offpeak_cutoff_hour: 18,
  daily_reset_hour: 0,
  rate_anchor: "delivery_confirm" as const,
  deduction_scope: "day_total" as const,
  repeat_zone_points: 1,
  holiday_source: "admin_calendar" as const,
  interplant_round_trip_halving: true,
};
let queryState: { isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };

vi.mock("../hooks/queries", () => ({
  useIncentiveRules: () => ({ ...queryState, data: queryState.isError ? undefined : rules, refetch: vi.fn() }),
  useDestinationRates: () => ({ data: [], isLoading: false, isError: false }),
  useRateAudit: () => ({ data: [], isLoading: false, isError: false }),
  useResetTruckRates: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrucks: () => ({ data: [], isLoading: false, isError: false }),
  useUpdateDestinationRate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTruckRates: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Real en.json, with real interpolation — the numbers under test arrive through
// `{{start}}` / `{{hour}}`, so a mock that ignored options would test nothing.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const raw = key.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), en);
      if (typeof raw !== "string") return key;
      return raw.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? `{{${name}}}`));
    },
  }),
}));

const renderPanel = async () => {
  const { FormulaTab } = await import("./IncentivesScreen");
  return renderToStaticMarkup(React.createElement(FormulaTab));
};

describe("Formula & Examples — the rules card actually has rules in it", () => {
  it("renders every calculation rule, not an empty card", async () => {
    queryState = { isLoading: false, isError: false };
    const html = await renderPanel();

    expect(html).toContain(en.admin.incentives.rulesTitle);
    // The bug: this card was blank. Each bullet is checked by a distinctive
    // fragment of its own sentence, so a card that renders one rule six times
    // cannot pass either.
    expect(html).toContain("per drop, per zone, per day, per driver");
    expect(html).toContain("floored at zero");
    expect(html).toContain("DELIVERY CONFIRM time");
    expect(html).toContain("resets at");
    expect(html).toContain("whole round trips");
  });

  it("states the deduction against the DAY TOTAL, never the first trip", async () => {
    queryState = { isLoading: false, isError: false };
    const html = await renderPanel();

    expect(html).toContain("total points, once per driver per day");
    expect(html.toLowerCase()).not.toContain("first trip of the day");
  });
});

describe("Formula & Examples — the bands come from the engine, not from the copy", () => {
  it("prints the engine's own peak window", async () => {
    queryState = { isLoading: false, isError: false };
    rules.peak_start_hour = 8;
    rules.offpeak_cutoff_hour = 18;
    const html = await renderPanel();

    expect(html).toContain("08:00");
    expect(html).toContain("18:00");
    // Off-peak must name the evening and the early morning, which is the case
    // "Weekend / Holiday" hid.
    expect(html).toContain(en.admin.incentives.offPeakCardTitle);
    expect(html).toContain("weekdays before 08:00 and from 18:00");
    expect(html).toContain("holiday calendar");
  });

  it("FOLLOWS the engine when the band moves — a hardcoded window fails here", async () => {
    queryState = { isLoading: false, isError: false };
    rules.peak_start_hour = 6;
    rules.offpeak_cutoff_hour = 20;
    const html = await renderPanel();

    expect(html).toContain("06:00");
    expect(html).toContain("20:00");
    expect(html).not.toContain("08:00");
    expect(html).not.toContain("18:00");

    rules.peak_start_hour = 8;
    rules.offpeak_cutoff_hour = 18;
  });

  it("drops the interplant rule when the engine is not halving", async () => {
    queryState = { isLoading: false, isError: false };
    rules.interplant_round_trip_halving = false;
    const html = await renderPanel();
    expect(html).not.toContain("whole round trips");
    rules.interplant_round_trip_halving = true;
  });

  it("says so rather than guessing when the rules cannot be loaded", async () => {
    // The alternative — falling back to baked-in numbers — is how the panel got
    // into this state. An honest error beats a confident wrong window.
    queryState = { isLoading: false, isError: true };
    const html = await renderPanel();
    expect(html).toContain(en.admin.incentives.rulesLoadError);
    expect(html).not.toContain("08:00");
    queryState = { isLoading: false, isError: false };
  });
});

describe("the retired claims are gone from ALL THREE locales", () => {
  // A locale file is where this drifts back: en can be fixed while ms still
  // says "trip pertama hari itu", and every parity guard passes because those
  // check KEYS, not wording.
  const LOCALES: Record<string, unknown> = { en, ms, zh };

  // Each entry is a claim that is FALSE, in the language it would appear in.
  const RETIRED: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /first trip of the day/i, why: "deduction comes off the day total, not the first trip" },
    { pattern: /trip pertama hari itu/i, why: "ms: same stale first-trip rule" },
    { pattern: /当日首趟/, why: "zh: same stale first-trip rule" },
    { pattern: /Malaysian public holidays/i, why: "R1 Q5: UWC's Batu Kawan list, not the national one" },
    { pattern: /cuti umum Malaysia/i, why: "ms: same national-holiday error" },
    { pattern: /马来西亚公共假期/, why: "zh: same national-holiday error" },
    { pattern: /07:00[–-]02:00/, why: "that is the pickup window, not a rate band — and B6 moved it" },
    { pattern: /Weekend \/ Holiday/i, why: "the bands are peak/off-peak; this hides the evening case" },
    { pattern: /Hujung Minggu \/ Cuti/i, why: "ms: same mislabelled band" },
    { pattern: /周末 \/ 假期/, why: "zh: same mislabelled band" },
  ];

  for (const [name, dict] of Object.entries(LOCALES)) {
    it(`${name}.json states none of them`, () => {
      const text = JSON.stringify(dict);
      // Non-vacuous: prove the haystack is the real locale file first. A scan
      // over an empty string passes every absence check ever written.
      expect(text.length).toBeGreaterThan(10_000);
      expect(text).toContain("incentives");

      for (const { pattern, why } of RETIRED) {
        expect(pattern.test(text), `${name}.json still claims: ${why}`).toBe(false);
      }
    });
  }

  it("scans the locale files as they exist ON DISK, not just as imported", () => {
    // The imports above are what the app bundles; this is the same content read
    // as bytes, so a stray duplicate key or a non-JSON edit cannot hide.
    for (const name of ["en", "ms", "zh"]) {
      const text = fs.readFileSync(path.resolve(__dirname, `../../i18n/${name}.json`), "utf-8");
      expect(text).toContain("ruleDeduction");
      expect(/first trip of the day/i.test(text), `${name}.json on disk`).toBe(false);
    }
  });
});
