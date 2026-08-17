import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * ONE "New Booking" AFFORDANCE PER SCREEN — never two, never zero.
 *
 * The bookings list carries a yellow floating button, and its EMPTY STATE
 * carries a navy "New Booking" button. On an empty list BOTH rendered: two
 * controls for one action, on a screen with nothing else on it.
 *
 * Deleting the FAB would have been the opposite failure — a requestor WITH
 * bookings would lose the one-handed way to create one — so the fix is a trade,
 * and a test that only checked "no FAB on the empty state" would pass just as
 * happily on a screen that had lost it everywhere. Both directions are pinned
 * below.
 *
 * ── WHY THIS READS SOURCE INSTEAD OF RENDERING ────────────────────────────
 *
 * The sibling specs (`DemoRoleSwitcher`, `incentiveFormulaCopy`) render their
 * screens for real through react-native-web. This one cannot: BookingListScreen
 * reaches Expo's native bridge (`expo-modules-core`, shipped as raw TypeScript
 * that Node's ESM loader refuses) through the i18n/constants chain, and stubbing
 * that out module by module produced a test whose mocks were larger and more
 * fragile than the screen.
 *
 * So this is a SOURCE-SHAPE guard, and it is worth being blunt about the
 * difference: it proves the FAB is WRITTEN under the right condition, not that
 * a browser DRAWS it that way. The browser half was checked by hand at 390 on
 * the demo build, empty list and populated list. If this screen ever becomes
 * renderable under vitest, replace this file with the real thing.
 */

const SOURCE = fs.readFileSync(path.resolve(__dirname, "./BookingListScreen.tsx"), "utf-8");

describe("requestor bookings — the New Booking affordances", () => {
  it("reads the screen it claims to check", () => {
    // Non-vacuous: every assertion below is a substring match, and substring
    // matches against an empty string are the classic vacuous pass.
    expect(SOURCE.length).toBeGreaterThan(2_000);
    expect(SOURCE).toContain("export function BookingListScreen");
  });

  it("still HAS a floating button — removing it entirely is the other bug", () => {
    expect(SOURCE, "the FAB must not be deleted outright").toContain("style={styles.fab}");
    expect(SOURCE).toContain("fab: {");
  });

  it("suppresses the FAB exactly when the empty state offers the same action", () => {
    // The condition, spelled out: empty list, on a tab whose empty state carries
    // its own button. NOT `filtered.length === 0` alone — that would strip the
    // FAB from the empty COMPLETED tab too, where the empty state deliberately
    // offers nothing and a requestor would be left with no way to book from
    // this screen at all.
    expect(SOURCE).toContain(
      'const emptyOffersItsOwnCta = filtered.length === 0 && filter !== "completed";'
    );

    // …and that it actually gates the FAB. Anchored on the JSX, so deleting the
    // guard while keeping the variable fails here.
    const guardAt = SOURCE.indexOf("{emptyOffersItsOwnCta ? null : (");
    expect(guardAt, "the FAB is not gated by the condition").toBeGreaterThan(-1);

    const fabAt = SOURCE.indexOf("style={styles.fab}");
    expect(fabAt, "the guard must sit ABOVE the FAB it guards").toBeGreaterThan(guardAt);
  });

  it("keeps the empty state's own button on the tabs that should offer one", () => {
    // The other half of the pair. If this button were deleted instead, the
    // empty ALL tab would have no create action at all — zero, not two.
    const start = SOURCE.indexOf("const emptyState = (");
    expect(start, "the empty state block moved or was renamed").toBeGreaterThan(-1);
    const emptyBlock = SOURCE.slice(start, SOURCE.indexOf("return (", start));

    expect(emptyBlock.length).toBeGreaterThan(200);
    expect(emptyBlock).toContain('filter !== "completed"');
    expect(emptyBlock).toContain("styles.emptyBtn");
    expect(emptyBlock).toContain('t("tabs.newBooking")');
  });
});
