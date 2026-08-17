import { describe, it, expect } from "vitest";
import { colors, statusColors } from "./theme";
import { colors as admin, status } from "./admin/theme";

/**
 * CONTRAST FLOOR for every colour pair a user actually reads.
 *
 * Drivers use this outdoors in direct sun, which is the whole reason the floor
 * is enforced rather than assumed. A 4 Aug 2026 audit measured the palette and
 * found real failures that had survived because contrast had only ever been
 * checked case by case: `textFaint` at 2.46:1 (used 146x, including the
 * inactive tab tint), the primary green "Delivered" button at 3.00:1, the
 * danger button at 4.23:1, the amber fuel nudge at 3.19:1, and the exception
 * card's `more_evidence` badge — white on yellow, about 1.4:1, on the one state
 * that asks the driver for something back.
 *
 * WCAG 2.1 AA is 4.5:1 for normal text. Everything here is normal text: the
 * 3:1 large-text allowance needs ≥18.66px bold, and these labels are 12-14px.
 *
 * ⚠ This pins PAIRS, not hex values — restyling is free as long as it stays
 * readable. If a pair here fails, do not lower the threshold; pick a better
 * colour, or the sunlight problem is back.
 */

const AA_NORMAL = 4.5;

function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text sits on white cards or on the app background; both must clear the floor.
const SURFACES: [string, string][] = [
  ["white card", colors.white],
  ["app background", colors.bg],
];

const READABLE_TEXT: [string, string][] = [
  ["primary text", colors.text],
  ["muted text", colors.textMuted],
  ["faint text", colors.textFaint],
  ["green figure (money)", colors.greenText],
  ["amber reminder", colors.amberText],
];

describe("palette contrast (WCAG AA, normal text)", () => {
  for (const [textName, fg] of READABLE_TEXT) {
    for (const [surfaceName, bg] of SURFACES) {
      it(`${textName} on ${surfaceName} clears ${AA_NORMAL}:1`, () => {
        const ratio = contrastRatio(fg, bg);
        expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }

  // Every status pill paints its own label — the pair has to work, not the hue.
  for (const [status, pair] of Object.entries(statusColors)) {
    it(`status pill "${status}" label is readable on its fill`, () => {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(ratio, `${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  // Filled buttons and badges that carry WHITE text. These are the pairs that
  // regressed before: the brand `green` and `red` are 3.00:1 and 4.23:1 under
  // white, so anything with a white label must use greenText / redDeep.
  const WHITE_LABEL_FILLS: [string, string][] = [
    ["primary button (blue)", colors.blue],
    ["success button / completed pill", colors.greenText],
    ["danger button / rejected pill", colors.redDeep],
    ["amber fuel-nudge pill", colors.amberText],
    ["in-progress (violet)", colors.violet],
    ["approved (teal)", colors.teal],
  ];
  for (const [name, bg] of WHITE_LABEL_FILLS) {
    it(`${name} carries white text at ${AA_NORMAL}:1`, () => {
      const ratio = contrastRatio(colors.white, bg);
      expect(ratio, `white on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  // ── THE ADMIN PALETTE, added 15 Aug 2026 ────────────────────────────────
  //
  // The 4 Aug audit that produced everything above covered the DRIVER and
  // REQUESTOR theme only. The admin app has its own token file, it was never
  // measured, and it had drifted into exactly the failures this file exists to
  // stop: warning text painted with a FILL colour on that fill's own tint.
  //
  // Every pair below is one that a real screen renders, and each was failing:
  // the approvals count pill (amber on yellowTint, 3.00:1), the "No POD" and
  // "No K2" pills (orange on orangeTint, 2.56:1 — the worst in the app), the
  // dispatch-bar attention chips (red on redTint, 3.70:1) and inline error text
  // (red on white, 4.23:1). Same rule as above: if one fails, pick a better
  // colour rather than lowering the floor.
  const ADMIN_TEXT_ON_TINT: [string, string, string][] = [
    ["approvals count / partial-trip pill", admin.amberText, admin.yellowTint],
    ["missing-evidence pill (No POD / No K2)", admin.amberText, admin.orangeTint],
    ["fleet-alert row, expiring band", admin.amberText, admin.orangeTint],
    ["fleet-alert row, expired band", admin.redText, admin.redTint],
    ["dispatch-bar attention chips", admin.redText, admin.redTint],
    ["evidence button (POD / K2)", admin.blue, admin.blueTint],
    ["inline error text", admin.redText, "#ffffff"],
    ["proposed incentive amount", admin.navy, "#ffffff"],
  ];
  for (const [name, fg, bg] of ADMIN_TEXT_ON_TINT) {
    it(`admin: ${name} clears ${AA_NORMAL}:1`, () => {
      const ratio = contrastRatio(fg, bg);
      expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  // Second pass, same day: the first one fixed the screens being edited, and a
  // 1440 capture then found the workload note still at 2.56:1 on a screen the
  // sweep had not visited. So this sweeps the REST of the admin app. Every pair
  // below was measured failing before it was changed:
  //
  //     sidebar approvals badge   white on orange        2.80:1
  //     exception state badge     white on orange        2.80:1
  //     truck expiry text         orange on white        2.80:1
  //     home "awaiting dispatch"  orange on white        2.80:1  (34px bold —
  //                               fails even the 3:1 large-text allowance)
  //     incentive tier pill       orange on orange@10%   2.53:1
  //
  // ⚠ Two screens had already hit this and each defined its OWN `ACCENT_AMBER =
  // "#B45309"` — the same hex, twice, loose. Both now read the token.
  const ADMIN_PASS_TWO: [string, string, string][] = [
    ["truck expiry / awaiting-dispatch figure", admin.amberText, "#ffffff"],
    ["incentive tier pill (orange at 10% over white)", admin.amberText, "#fef1e8"],
  ];
  for (const [name, fg, bg] of ADMIN_PASS_TWO) {
    it(`admin: ${name} clears ${AA_NORMAL}:1`, () => {
      const ratio = contrastRatio(fg, bg);
      expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("admin: the count badges carry white text at 4.5:1", () => {
    // Sidebar approvals badge and the exception lane's state badge. The latter
    // matters most: that surface is the next one due to be switched on.
    const ratio = contrastRatio("#ffffff", admin.amberText);
    expect(ratio, `white on ${admin.amberText} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  // NON-TEXT components (borders, accent bars, dots) have a 3:1 floor, not 4.5.
  // The trips board's group accent is a border, so it does NOT need the dark
  // text token — but it did need to stop being `orange`, which was 2.80:1 and
  // failed even this lower bar.
  const AA_NON_TEXT = 3;
  it("admin: the trips-board group accent clears the 3:1 non-text floor", () => {
    const ratio = contrastRatio(admin.amber, "#ffffff");
    expect(ratio, `${admin.amber} on white = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NON_TEXT);

    // And the colour it replaced did not — this is why the swap happened.
    //
    // ⚠ Asserted against the LITERAL historical hex, not `admin.orange`. It
    // used to read the token, which made a fixed historical fact depend on a
    // live value: when the 17 Aug handoff re-pointed `orange` from #F97316 to
    // the external family's #EA580C (3.56:1), this line failed — reporting a
    // palette IMPROVEMENT as a regression. A note about the past should be
    // written in the past's own values.
    expect(contrastRatio("#F97316", "#ffffff")).toBeLessThan(AA_NON_TEXT);

    // The colour that now carries `orange` clears the non-text floor as well,
    // so the swap did not quietly reintroduce the problem one hue over.
    expect(contrastRatio(admin.orange, "#ffffff")).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // The split is the point: `amber`/`red`/`orange` stay as FILLS and borders,
  // and none of them is fit to be small text on its own tint. Pinning that
  // keeps someone from "simplifying" the two tokens back into one.
  it("admin: the raw fill colours are NOT text-safe — which is why the Text variants exist", () => {
    expect(contrastRatio(admin.amber, admin.yellowTint)).toBeLessThan(AA_NORMAL);
    expect(contrastRatio(admin.orange, admin.orangeTint)).toBeLessThan(AA_NORMAL);
    expect(contrastRatio(admin.red, admin.redTint)).toBeLessThan(AA_NORMAL);
  });

  // Guard the decision itself: textFaint must stay READABLE but still be a
  // distinct third tier. If it drifts darker than textMuted the hierarchy has
  // collapsed and the design has quietly lost a level.
  it("keeps three distinct text tiers", () => {
    const faint = contrastRatio(colors.textFaint, colors.white);
    const muted = contrastRatio(colors.textMuted, colors.white);
    const primary = contrastRatio(colors.text, colors.white);
    expect(faint).toBeLessThan(muted);
    expect(muted).toBeLessThan(primary);
  });
});

/**
 * THE SEMANTIC STATUS FAMILY (design handoff, 17 Aug 2026).
 *
 * The handoff gives one solid per meaning. Several of those solids are NOT
 * readable as small text on their own tint, which is why the family carries a
 * separate `text` variant — and why that claim is measured here rather than
 * asserted in a comment.
 *
 * The first test proves the DISTINCTION IS REAL: if a `text` variant were ever
 * "simplified" back to its solid, the pair drops below the floor and this file
 * goes red. Without it the family would look tidy and read badly, which is
 * exactly how the 4 Aug palette got into the state it was in.
 */
describe("status family — the text variant is what makes it readable", () => {
  for (const [name, fam] of Object.entries(status)) {
    it(`${name}: text on its own tint clears AA`, () => {
      const ratio = contrastRatio(fam.text, fam.tint);
      expect(ratio, `${name} text ${fam.text} on ${fam.tint} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it(`${name}: text on a white card clears AA`, () => {
      const ratio = contrastRatio(fam.text, colors.white);
      expect(ratio, `${name} text ${fam.text} on white = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it(`${name}: white on the TEXT variant clears AA — that is what a filled pill uses`, () => {
      // Contrast is symmetric, so the darker sibling doubles as the fill under
      // white text. This is the same two-jobs-one-token shape the driver
      // palette's `greenText` already documents.
      const ratio = contrastRatio(colors.white, fam.text);
      expect(ratio, `white on ${name} text ${fam.text} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("pins WHITE-ON-SOLID as unsafe — solids are dots, borders and glyphs only", () => {
    // Measured, 17 Aug 2026: four of the six handoff solids sit at 3.19-3.74:1
    // under white text. That is not a reason to reject the palette — they were
    // given as fills, dots and borders, and they are fine for that — but a
    // filled pill with a white label must take the `text` variant instead.
    // Recorded as a test so the next person reaches for the right one.
    const unsafe = Object.entries(status)
      .map(([name, fam]) => [name, contrastRatio(colors.white, fam.solid)] as const)
      .filter(([, ratio]) => ratio < AA_NORMAL)
      .map(([name]) => name);

    expect(unsafe.sort()).toEqual(["eco", "external", "success", "warning"]);
  });

  it("proves the solids would NOT have done as text — the reason `text` exists", () => {
    // Not a style preference: adopting the handoff's solid as small text is a
    // measurable regression, and this records by how much. If a future palette
    // makes a solid readable on its own tint, this test fails and the extra
    // variant can be retired deliberately rather than by accident.
    const failing = Object.entries(status)
      .map(([name, fam]) => [name, contrastRatio(fam.solid, fam.tint)] as const)
      .filter(([, ratio]) => ratio < AA_NORMAL)
      .map(([name]) => name);

    expect(failing.length, "no solid fails as text — the `text` variants may be unnecessary now").toBeGreaterThan(0);
    expect(failing).toContain("success");
    expect(failing).toContain("warning");
  });
});
