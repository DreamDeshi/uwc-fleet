import { describe, it, expect } from "vitest";
import { colors, statusColors } from "./theme";

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
