import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * GET /incentives/rules — the endpoint the admin "Formula & Examples" panel
 * reads instead of restating the pay rules by hand.
 *
 * The bug this replaces was not a typo. The panel said the daily deduction came
 * off "the first trip of the day" — true before aa8d081, false since — and an
 * admin reading it would have mis-explained a driver's pay. Hand-written copy
 * about money drifts because nothing fails when it does.
 *
 * So the values are the ENGINE'S OWN constants, and this file checks two
 * different things, because the first alone would be circular:
 *
 *   1. the response equals what `incentiveEngine` exports;
 *   2. those exports actually describe how `isOffPeak` BEHAVES, hour by hour
 *      across both boundaries.
 *
 * Without (2) the endpoint could return a matching pair of wrong numbers — the
 * tautological pin this repo has shipped before. With it, the numbers are
 * anchored to the function that decides which rate a driver is paid.
 */

// Auth is stubbed so this stays a pure route test: no DB, no tokens. The role
// guard is exercised as itself (test 3), not waved through.
const currentUser = { id: "u1", role: "admin" };
vi.mock("../src/middleware/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));
vi.mock("../src/middleware/roleGuard", () => ({
  requireRole:
    (role: string) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as unknown as { user?: { role: string } }).user;
      if (user?.role !== role) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "wrong role" } });
        return;
      }
      next();
    },
}));

const loadApp = async () => {
  const { default: incentivesRouter } = await import("../src/routes/incentives");
  const app = express();
  app.use("/api/v1/incentives", incentivesRouter);
  return app;
};

beforeEach(() => {
  currentUser.role = "admin";
});

describe("GET /incentives/rules", () => {
  it("returns the engine's own constants, not a second copy of them", async () => {
    const engine = await import("../src/services/incentiveEngine");
    const app = await loadApp();

    const res = await request(app).get("/api/v1/incentives/rules");

    expect(res.status).toBe(200);
    expect(res.body.peak_start_hour).toBe(engine.PEAK_START_HOUR);
    expect(res.body.offpeak_cutoff_hour).toBe(engine.OFFPEAK_CUTOFF_HOUR);
    expect(res.body.daily_reset_hour).toBe(engine.DAILY_RESET_HOUR);
  });

  it("describes the rules the panel states in words", async () => {
    const app = await loadApp();
    const res = await request(app).get("/api/v1/incentives/rules");

    // Each of these is a sentence on the screen. If the engine ever stops
    // matching one, the value here must change and the copy with it.
    expect(res.body.deduction_scope).toBe("day_total"); // NOT the first trip
    expect(res.body.rate_anchor).toBe("delivery_confirm"); // NOT pickup time
    expect(res.body.holiday_source).toBe("admin_calendar"); // NOT a national list
    expect(res.body.repeat_zone_points).toBe(1);
    expect(res.body.interplant_round_trip_halving).toBe(true);
  });

  it("is admin-only", async () => {
    currentUser.role = "requestor";
    const app = await loadApp();
    const res = await request(app).get("/api/v1/incentives/rules");
    expect(res.status).toBe(403);
  });

  it("is REACHABLE on the real app, and authenticated there", async () => {
    // The tests above mount the router themselves, which proves the handler
    // works and proves nothing about whether anything serves it. A correct
    // handler on an unmounted router is the dead-code failure this repo keeps
    // shipping. Ask the REAL app, with the REAL middleware: an unauthenticated
    // request must be REFUSED (401), not NOT-FOUND (404).
    vi.resetModules();
    vi.doUnmock("../src/middleware/auth");
    vi.doUnmock("../src/middleware/roleGuard");
    const { app } = await import("../src/app");
    const res = await request(app).get("/api/v1/incentives/rules");
    expect(res.status, "route is not mounted on the app").not.toBe(404);
    expect(res.status).toBe(401);
  });
});

describe("the constants describe how the engine actually prices an hour", () => {
  // This is what stops the endpoint from being a pair of numbers that agree
  // with each other and with nothing else. Every assertion below is a claim the
  // panel makes in words, checked against isOffPeak itself.
  const NO_HOLIDAYS = new Set<string>();
  // 2026-08-17 is a Monday, 2026-08-22 a Saturday, 2026-08-23 a Sunday.
  const mondayAt = (hour: number) => new Date(Date.UTC(2026, 7, 17, hour - 8, 0, 0));

  it("peak is the weekday band [peak_start_hour, offpeak_cutoff_hour) in MYT", async () => {
    const { isOffPeak, PEAK_START_HOUR, OFFPEAK_CUTOFF_HOUR } = await import(
      "../src/services/incentiveEngine"
    );

    // Inside the band → peak.
    expect(isOffPeak(mondayAt(PEAK_START_HOUR), NO_HOLIDAYS)).toBe(false);
    expect(isOffPeak(mondayAt(OFFPEAK_CUTOFF_HOUR - 1), NO_HOLIDAYS)).toBe(false);

    // BOTH boundaries, which is the half the old copy hid: an evening delivery
    // and an early-morning one are off-peak, not just weekends.
    expect(isOffPeak(mondayAt(PEAK_START_HOUR - 1), NO_HOLIDAYS)).toBe(true);
    expect(isOffPeak(mondayAt(OFFPEAK_CUTOFF_HOUR), NO_HOLIDAYS)).toBe(true);
  });

  it("weekends are off-peak at any hour, including inside the weekday band", async () => {
    const { isOffPeak, PEAK_START_HOUR } = await import("../src/services/incentiveEngine");
    const saturdayNoon = new Date(Date.UTC(2026, 7, 22, PEAK_START_HOUR + 2 - 8, 0, 0));
    const sundayNoon = new Date(Date.UTC(2026, 7, 23, PEAK_START_HOUR + 2 - 8, 0, 0));
    expect(isOffPeak(saturdayNoon, NO_HOLIDAYS)).toBe(true);
    expect(isOffPeak(sundayNoon, NO_HOLIDAYS)).toBe(true);
  });

  it("a holiday is off-peak ONLY when the admin calendar carries that date", async () => {
    const { isOffPeak, mytDateKey } = await import("../src/services/incentiveEngine");
    const mondayMidday = mondayAt(12);

    // The engine holds no baked-in holiday list — this is why the copy must say
    // "UWC's holiday calendar" and not "Malaysian public holidays". A national
    // holiday UWC does not observe (the Perak Sultan's birthday, R1 Q5) simply
    // never reaches this set, and the day stays peak.
    expect(isOffPeak(mondayMidday, new Set())).toBe(false);
    expect(isOffPeak(mondayMidday, new Set([mytDateKey(mondayMidday)]))).toBe(true);
  });

  it("the deduction comes off the DAY TOTAL once, floored at zero", async () => {
    const { calculateDeliveryIncentive } = await import("../src/services/incentiveEngine");
    const truck = {
      daily_deduction_points: 2,
      entitled_claim_weekday: 11,
      entitled_claim_offpeak: 13,
    };
    const at = mondayAt(10);
    const common = { rateDateTime: at, publicHolidays: NO_HOLIDAYS, truck };

    // Day's FIRST group: 6 pts, deduction 2 → 4 × RM11.
    const first = calculateDeliveryIncentive({
      ...common,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
    });
    expect(first.incentiveThisTrip).toBe(44);
    expect(first.deductionApplied).toBe(2);

    // A LATER group the same day takes NO further deduction — it is spent once
    // on the day's total, which is precisely what "on the first trip of the
    // day" got wrong: it is not a per-trip charge, and it is not tied to the
    // first trip either (see the floor case below).
    const later = calculateDeliveryIncentive({
      ...common,
      drops: [{ zoneCode: "KL", zonePoints: 8 }],
      zonesDeliveredEarlierToday: ["A2"],
      priorPointsToday: 6,
    });
    expect(later.deductionApplied).toBe(0);
    expect(later.incentiveThisTrip).toBe(8 * 11);

    // FLOORED AT ZERO, and the unspent remainder CARRIES: a 1-point first drop
    // cannot go negative, and the leftover deduction lands on the next group.
    const tiny = calculateDeliveryIncentive({
      ...common,
      drops: [{ zoneCode: "P2", zonePoints: 1 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
    });
    expect(tiny.incentiveThisTrip).toBe(0);

    const afterTiny = calculateDeliveryIncentive({
      ...common,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: ["P2"],
      priorPointsToday: 1,
    });
    // Day total 7 pts − 2 = 5 × RM11 = RM55, of which RM0 was paid on the first
    // drop — so this group carries the whole RM55.
    expect(tiny.incentiveThisTrip + afterTiny.incentiveThisTrip).toBe(55);
  });

  it("a repeat drop into a zone already delivered to today scores exactly 1", async () => {
    const { scoreDrops } = await import("../src/services/incentiveEngine");
    expect(scoreDrops([{ zoneCode: "A2", zonePoints: 6 }], ["A2"])).toEqual([1]);
    expect(
      scoreDrops([
        { zoneCode: "A2", zonePoints: 6 },
        { zoneCode: "A2", zonePoints: 6 },
      ])
    ).toEqual([6, 1]);
  });
});
