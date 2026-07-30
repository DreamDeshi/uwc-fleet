import { test, expect } from "@playwright/test";
import { ADMIN, DRIVER, REQUESTOR } from "../helpers/accounts";
import { approveTrip, driverIdentity, login, setTruckWindow } from "../helpers/api";
import { seedPendingTripToday } from "../helpers/seed";
import { resetState } from "../helpers/reset";

/**
 * THE OPERATING-WINDOW GUARD.
 *
 * Assignment rejects a pickup outside the truck's operating hours with a hard
 * 409 OPERATING_WINDOW (api/src/routes/trips.ts), overridable only with
 * `force`. That rule had NO end-to-end cover: every spec either scheduled
 * tomorrow 09:00, safely inside the seeded 07:00-02:00, or passed `force: true`
 * and skipped the check entirely.
 *
 * It is covered here by narrowing a truck's window on purpose — real data
 * through the real admin endpoint — rather than by moving the clock. That makes
 * the assertion deterministic at any hour AND leaves the production code path
 * exactly as it ships. globalSetup widens this same truck to 00:00-23:59 for
 * the run; this spec narrows it for one test and puts it back.
 */

/** A one-hour window three hours from now in MYT, so it cannot contain "now". */
function windowExcludingNow(): { start: string; end: string } {
  const mytHour = (new Date().getUTCHours() + 8) % 24; // MYT is UTC+8, no DST
  const pad = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  // (h+3)..(h+4) excludes h whether or not the range wraps midnight.
  return { start: pad(mytHour + 3), end: pad(mytHour + 4) };
}

/**
 * Mirrors setup.ts's alwaysOpenWindow — a wrapping window that began an hour
 * ago, so every pickup lands in windowEndInstant's roll-forward branch with
 * ~23 hours of completion slack. See the long note there; a fixed wall-clock
 * end cannot give that guarantee at every hour.
 */
function runWideWindow(): { start: string; end: string } {
  const mytMinutes = Math.floor((Date.now() + 8 * 60 * 60 * 1000) / 60000) % 1440;
  const start = (mytMinutes - 60 + 1440) % 1440;
  const end = (start - 1 + 1440) % 1440;
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { start: hhmm(start), end: hhmm(end) };
}

test.describe("operating window", () => {
  test.beforeEach(async () => {
    await resetState();
  });

  test("W1. a pickup outside the truck's hours is refused, and force overrides it", async () => {
    const admin = await login(ADMIN);
    const requestor = await login(REQUESTOR);
    const driver = await driverIdentity(DRIVER);
    const narrow = windowExcludingNow();

    try {
      await setTruckWindow(admin.accessToken, driver.plate, narrow);

      // seedPendingTripToday books five minutes ago — inside the run-wide 24h
      // window, outside the narrow one we just set.
      const trip = await seedPendingTripToday(requestor.accessToken);

      // Unforced: the guard fires.
      await expect(
        approveTrip(admin.accessToken, trip.id, {
          driver_id: driver.id,
          truck_plate: driver.plate,
        })
      ).rejects.toThrow(/OPERATING_WINDOW/);

      // The trip is untouched by the refusal — still assignable.
      const forced = await approveTrip(admin.accessToken, trip.id, {
        driver_id: driver.id,
        truck_plate: driver.plate,
        force: true,
      });
      expect(forced.status).toBe("assigned");
      expect(forced.driver_id).toBe(driver.id);
    } finally {
      // Hand the run-wide window back even if the assertions blew up, or every
      // later spec inherits a one-hour truck.
      await setTruckWindow(admin.accessToken, driver.plate, runWideWindow()).catch(() => {});
    }
  });

  test("W2. the same pickup assigns cleanly once the window contains it", async () => {
    // The control. Without it, W1 would pass just as happily if assignment were
    // broken for some unrelated reason — every unforced approve would "correctly"
    // throw and nobody would notice.
    const admin = await login(ADMIN);
    const requestor = await login(REQUESTOR);
    const driver = await driverIdentity(DRIVER);

    await setTruckWindow(admin.accessToken, driver.plate, runWideWindow());
    const trip = await seedPendingTripToday(requestor.accessToken);

    const assigned = await approveTrip(admin.accessToken, trip.id, {
      driver_id: driver.id,
      truck_plate: driver.plate,
    });
    expect(assigned.status).toBe("assigned");
  });
});
