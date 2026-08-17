import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mytDayKey, sameMytDay } from "./mytDay";

/**
 * The client's "today" must be MALAYSIA's today, not the device's.
 *
 * ⚠ THE SUITE RUNS PINNED TO Asia/Kuala_Lumpur (see vitest.config.ts), which
 * means a device-clock implementation PASSES most naive tests here — the very
 * thing that let this ship. Every case below is therefore built from INSTANTS
 * whose MYT day differs from their UTC day, so the assertion is about the
 * conversion and not about the runner's timezone.
 */
describe("mytDayKey — the server's day, from the client", () => {
  it("reads the MYT wall-clock day, not the UTC one", () => {
    // 17 Aug 2026 18:30 UTC == 18 Aug 02:30 MYT. UTC says the 17th; MYT says
    // the 18th, and the server bins this instant on the 18th.
    expect(mytDayKey(new Date("2026-08-17T18:30:00Z"))).toBe("2026-08-18");
  });

  it("holds at the MYT midnight boundary from both sides", () => {
    expect(mytDayKey(new Date("2026-08-17T15:59:59Z"))).toBe("2026-08-17"); // 23:59:59 MYT
    expect(mytDayKey(new Date("2026-08-17T16:00:00Z"))).toBe("2026-08-18"); // 00:00:00 MYT
  });

  it("pads, so the key sorts and matches the server's format", () => {
    expect(mytDayKey(new Date("2026-01-05T04:00:00Z"))).toBe("2026-01-05");
  });

  it("sameMytDay groups an 00:55 pickup with the calendar day it falls in", () => {
    // The 00:55 MYT pickup and the 09:00 MYT one the same morning are the same
    // MYT day. (Whether the 00:55 belongs to the PREVIOUS SHIFT is a different
    // question, deliberately unanswered — see the note in mytDay.ts.)
    const lateNight = new Date("2026-08-17T16:55:00Z"); // 00:55 MYT on the 18th
    const morning = new Date("2026-08-18T01:00:00Z"); // 09:00 MYT on the 18th
    expect(sameMytDay(lateNight, morning)).toBe(true);

    const eveningBefore = new Date("2026-08-17T11:00:00Z"); // 19:00 MYT on the 17th
    expect(sameMytDay(lateNight, eveningBefore)).toBe(false);
  });
});

describe("no screen decides 'today' on the device clock", () => {
  /**
   * The regression guard. Both home screens computed their own day from the
   * device — `toDateString()` on the driver's, a local Y/M/D compare on the
   * requestor's — so the app and the server agreed only while the device
   * happened to be on MYT. The WEB build is the case that breaks it: a laptop
   * on UTC is 8 hours behind, and from midnight to 08:00 MYT the driver's Home
   * said "no trips assigned today" about a day the dashboard called today.
   *
   * Asserted on SOURCE because the bug is which clock is consulted, and a unit
   * test under a pinned TZ cannot see the difference.
   */
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf-8");

  /**
   * ⚠ STRIP COMMENTS BEFORE SCANNING. The first version of this guard failed on
   * the FIX: the comment explaining that the code "used to read the DEVICE clock
   * (`toDateString()`)" contains the very string the guard forbids. A source
   * scan that reads comments cannot tell code from documentation ABOUT that
   * code, and it punishes the note that makes the fix understandable — the exact
   * opposite of what this repo wants written down.
   */
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const file of ["./driverHome.ts", "./requestorHome.ts"]) {
    it(`${file} uses the MYT helper, not the device clock`, () => {
      const src = codeOnly(read(file));
      expect(src.length, "file moved or was renamed").toBeGreaterThan(500);
      expect(src, "must consult MYT").toContain("sameMytDay");
      expect(src, "toDateString() reads the DEVICE day").not.toContain("toDateString()");
      expect(src, "a local Y/M/D compare reads the DEVICE day").not.toMatch(
        /getFullYear\(\)\s*===\s*\w+\.getFullYear\(\)/
      );
    });
  }
});
