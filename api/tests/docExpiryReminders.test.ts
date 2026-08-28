import { describe, it, expect } from "vitest";
import {
  expiringDocsWhere,
  msUntilNextReminder,
  DOC_EXPIRY_REMIND_DAYS_DEFAULT,
} from "../src/services/docExpiryReminders";

/**
 * This file had ZERO test coverage before admin-settings Phase 4 (28 Aug
 * 2026) touched it to make DOC_EXPIRY_REMIND_DAYS admin-editable. Pinning the
 * pure parts here rather than leaving them entirely unverified.
 */

describe("expiringDocsWhere — the query scope", () => {
  const now = new Date("2026-08-28T00:00:00Z");

  it("excludes retired trucks", () => {
    expect(expiringDocsWhere(now, 30).retired_at).toBeNull();
  });

  it("checks all three document fields, each against the same horizon", () => {
    const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(expiringDocsWhere(now, 30)).toEqual({
      retired_at: null,
      OR: [
        { insurance_expiry: { lte: horizon } },
        { permit_expiry: { lte: horizon } },
        { road_tax_expiry: { lte: horizon } },
      ],
    });
  });

  it("a wider window moves the horizon further out", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const wideHorizon = new Date(now.getTime() + 60 * DAY_MS);
    const narrowHorizon = new Date(now.getTime() + 30 * DAY_MS);
    expect(expiringDocsWhere(now, 60)).toEqual({
      retired_at: null,
      OR: [
        { insurance_expiry: { lte: wideHorizon } },
        { permit_expiry: { lte: wideHorizon } },
        { road_tax_expiry: { lte: wideHorizon } },
      ],
    });
    expect(wideHorizon.getTime()).toBeGreaterThan(narrowHorizon.getTime());
  });
});

describe("DOC_EXPIRY_REMIND_DAYS_DEFAULT — the registry's default matches this file's own", () => {
  it("is the documented 30-day default absent an env override", () => {
    expect(DOC_EXPIRY_REMIND_DAYS_DEFAULT).toBe(30);
  });
});

describe("msUntilNextReminder — the daily 09:00 MYT slot", () => {
  it("counts forward to today's slot when still ahead", () => {
    const beforeSlot = new Date("2026-08-28T00:00:00Z"); // 08:00 MYT
    const ms = msUntilNextReminder(beforeSlot);
    const fired = new Date(beforeSlot.getTime() + ms);
    expect(fired.toISOString()).toBe("2026-08-28T01:00:00.000Z"); // 09:00 MYT
  });

  it("rolls to tomorrow's slot once today's has passed", () => {
    const afterSlot = new Date("2026-08-28T02:00:00Z"); // 10:00 MYT
    const ms = msUntilNextReminder(afterSlot);
    const fired = new Date(afterSlot.getTime() + ms);
    expect(fired.toISOString()).toBe("2026-08-29T01:00:00.000Z");
  });
});
