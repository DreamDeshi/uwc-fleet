import { test, expect } from "@playwright/test";
import { MOBILE_URL } from "../helpers/accounts";

/**
 * The demo one-tap role switcher must not exist in a build that did not ask for
 * it. The unit suite renders the login screen with the flag off and asserts the
 * same thing; this spec asserts it about the BUILT BUNDLE the browser actually
 * loads, which is the artefact that ships.
 *
 * That distinction has bitten this repo before — a stale or differently-built
 * bundle answers confidently about a program you are not running. Here the two
 * checks disagree only if the build inlines the flag differently from the way
 * the test environment reads it, which is exactly the failure worth catching.
 *
 * ⚠ If the demo flags are ever set for a CI run, this spec SHOULD fail. It is a
 * statement about the default build, and the demo build is a separate service.
 */
test.describe("demo one-tap login is absent from a normal build", () => {
  test("login screen offers no role shortcut, and still offers the form", async ({ page }) => {
    await page.goto(MOBILE_URL);

    // Prove the login screen actually rendered FIRST. Without this, a blank
    // page, a crashed bundle or a redirect would satisfy every absence
    // assertion below — "there is nothing there" and "I never got there" look
    // identical until you separate them.
    await expect(page.getByPlaceholder("12-345 6789")).toBeVisible();
    await expect(page.getByText("Sign In", { exact: true })).toBeVisible();

    for (const label of ["Try as Admin", "Try as Driver", "Try as Requestor", "Demo — one tap"]) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
  });
});
