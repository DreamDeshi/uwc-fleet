import { describe, it, expect, afterEach } from "vitest";
import {
  minutesFromEnv,
  nonNegativeMinutesFromEnv,
  numberFromEnv,
  countFromEnv,
} from "../src/lib/envNumbers";

/**
 * These three were FIVE private copies across six modules, and collecting them
 * is only safe because the ONE that differs is pinned here.
 *
 *   minutesFromEnv             exceptionAlerts, pendingTripAlerts,
 *                              schedulingConflict          (n > 0)
 *   nonNegativeMinutesFromEnv  operatingWindow             (n >= 0)  ← differs
 *   numberFromEnv              consolidationSavings, rightSizingSavings
 *
 * The operatingWindow copy shared the NAME `minutesFromEnv` with the other
 * three and differed by one character. Folding it in would have made
 * `OP_LOAD_MIN=0` fall back to 30 minutes, changing the estimated completion
 * that decides a 409 OPERATING_WINDOW on assignment — a dispatch bug introduced
 * while removing a duplicate.
 *
 * So the test that matters most in this file is the last one: the two minute
 * readers must DISAGREE about "0". If someone ever unifies them, that is what
 * goes red.
 */
const VAR = "TEST_ENV_NUMBER";

afterEach(() => {
  delete process.env[VAR];
});
const set = (v: string | undefined) => {
  if (v === undefined) delete process.env[VAR];
  else process.env[VAR] = v;
};

describe("minutesFromEnv — positive integers only", () => {
  it("takes a positive integer", () => {
    set("15");
    expect(minutesFromEnv(VAR, 30)).toBe(15);
  });

  it("falls back on unset, blank and whitespace", () => {
    for (const v of [undefined, "", "   "]) {
      set(v);
      expect(minutesFromEnv(VAR, 30), `value ${JSON.stringify(v)}`).toBe(30);
    }
    // `Number("")` is 0, so blank-means-default is a real decision, not an
    // accident: `FOO=` in a .env must not disable a threshold.
  });

  it("falls back on zero, negatives, floats and junk", () => {
    for (const v of ["0", "-5", "1.5", "abc", "15m", "Infinity", "NaN"]) {
      set(v);
      expect(minutesFromEnv(VAR, 30), `value ${JSON.stringify(v)}`).toBe(30);
    }
  });
});

describe("nonNegativeMinutesFromEnv — zero is a real setting", () => {
  it("accepts zero", () => {
    set("0");
    expect(nonNegativeMinutesFromEnv(VAR, 30)).toBe(0);
  });

  it("still rejects negatives, floats and junk", () => {
    for (const v of ["-1", "2.5", "abc", ""]) {
      set(v);
      expect(nonNegativeMinutesFromEnv(VAR, 30), `value ${JSON.stringify(v)}`).toBe(30);
    }
  });
});

describe("numberFromEnv — positive finite, floats allowed", () => {
  it("takes a float, because these are physical quantities", () => {
    set("2.68"); // kg CO2e per litre
    expect(numberFromEnv(VAR, 1)).toBe(2.68);
  });

  it("rejects zero, so an estimate factor cannot be configured away", () => {
    set("0");
    expect(numberFromEnv(VAR, 35)).toBe(35);
  });

  it("rejects negatives, Infinity and junk", () => {
    for (const v of ["-1", "Infinity", "-Infinity", "abc", ""]) {
      set(v);
      expect(numberFromEnv(VAR, 35), `value ${JSON.stringify(v)}`).toBe(35);
    }
  });
});

describe("countFromEnv — a row count, not a physical quantity", () => {
  it("takes a positive integer and rejects a float", () => {
    // A fractional limit makes `take` and `slice` disagree about the boundary.
    set("200");
    expect(countFromEnv(VAR, 50)).toBe(200);
    set("200.5");
    expect(countFromEnv(VAR, 50)).toBe(50);
  });

  it("rejects zero, negatives and junk", () => {
    for (const v of ["0", "-1", "abc", "", undefined]) {
      set(v);
      expect(countFromEnv(VAR, 50), `value ${JSON.stringify(v)}`).toBe(50);
    }
  });

  it("agrees with minutesFromEnv — same rule, two honest names", () => {
    // Deliberately two NAMES for one behaviour (the safe direction). The
    // dangerous direction, two BEHAVIOURS under one name, is what
    // nonNegativeMinutesFromEnv exists to undo.
    for (const v of ["1", "200", "0", "-1", "2.5", "", undefined]) {
      set(v);
      expect(countFromEnv(VAR, 7), `value ${JSON.stringify(v)}`).toBe(minutesFromEnv(VAR, 7));
    }
  });
});

describe("the two minute readers must NOT be unified", () => {
  it('they disagree about "0", and that difference is load-bearing', () => {
    set("0");
    // operatingWindow means it: a site with no loading time. The alert
    // thresholds do not: 0 would mean "alert on everything, immediately".
    expect(nonNegativeMinutesFromEnv(VAR, 30)).toBe(0);
    expect(minutesFromEnv(VAR, 30)).toBe(30);
    expect(nonNegativeMinutesFromEnv(VAR, 30)).not.toBe(minutesFromEnv(VAR, 30));
  });

  it("and agree about everything else", () => {
    // So the split is exactly one case wide — no room for a second divergence
    // to hide behind the first.
    for (const v of [undefined, "", "  ", "15", "-1", "1.5", "abc"]) {
      set(v);
      expect(nonNegativeMinutesFromEnv(VAR, 30), `value ${JSON.stringify(v)}`).toBe(
        minutesFromEnv(VAR, 30)
      );
    }
  });
});
