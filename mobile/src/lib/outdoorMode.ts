import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors } from "../theme";
import type { TripStatus } from "../types";

/**
 * DRIVER OUTDOOR MODE — a high-contrast variant for a screen read in Penang sun.
 *
 * ── WHY THE INDOOR FLOOR IS NOT ENOUGH ──────────────────────────────────────
 *
 * The palette targets WCAG AA (4.5:1), which is defined for an sRGB display in
 * a DARK SURROUND — an office. The driver app is the only surface used
 * outdoors, and it inherited that assumption.
 *
 * Sunlight reflecting off the glass adds the SAME luminance to text and
 * background, and adding a constant to both sides of a ratio drives it toward
 * 1. Measured (see theme.contrast.test.ts, "outdoor"):
 *
 *     pair                    indoors   +0.25 veil   +0.5   +1.0
 *     #666 on white (AA)         5.74         3.00   2.27   1.73
 *     AAA-grade on white         9.30         3.58   2.53   1.84
 *     black on white            21.00         4.33   2.82   1.95
 *
 * Two things follow, and the second matters more than the first:
 *   1. AA indoors is roughly 3:1 in moderate glare — under the NON-TEXT floor.
 *   2. NOTHING survives strong sun on ratio alone. So this mode raises the
 *      floor to AAA (7:1) for text and 4.5:1 for components, and leans on the
 *      things that actually help outdoors: WEIGHT, SOLID FILLS, and no tints.
 *
 * ⚠ THIS PHASE IS COLOUR AND WEIGHT ONLY. Touch-target sizing lands separately
 * (owner, 17 Aug): a contrast pass is reviewable from a screenshot and a
 * spacing pass is not, so shipping them together makes both harder to check.
 *
 * ── WHY THE PREFERENCE IS NOT SCOPED TO THE USER ────────────────────────────
 *
 * `scopedStorage` keys per-driver data by the signed-in user, and this key
 * deliberately sits outside it. Owner ruling, 17 Aug 2026:
 *
 *     "Language follows the person, glare follows the place."
 *
 * A driver handing a handset to the next man in the same yard, in the same sun,
 * is handing over a setting the next man probably wants. The preference
 * describes the PHONE'S ENVIRONMENT, not the person holding it, so it stays on
 * the device across sign-ins. Recorded here and in the scopedStorage allowlist
 * so it never reads as an oversight.
 */
const OUTDOOR_KEY = "uwc.outdoorMode";

export async function loadOutdoorMode(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(OUTDOOR_KEY)) === "1";
  } catch {
    return false; // a storage failure must never force a mode on anyone
  }
}

export async function saveOutdoorMode(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(OUTDOOR_KEY, on ? "1" : "0");
  } catch {
    /* best effort — the toggle still applies for this session */
  }
}

/**
 * The outdoor overrides. SAME HUES, one step darker where a fill has to carry
 * white text at 7:1 — six values, not a second palette. Every one is measured
 * in theme.contrast.test.ts rather than eyeballed.
 *
 * `ground` is white on purpose: the app background (#f4f6fb) costs about half a
 * point of contrast against dark text, and it is also what makes the tint
 * family readable indoors. Outdoors the tints go and the ground goes white.
 */
export const outdoor = {
  ground: "#FFFFFF",
  text: colors.text, // #1A1F5E — 14.98:1 on white, already past the floor
  textMuted: "#555555", // 7.46:1 on white (was #666666, 5.74:1)
  textFaint: "#4E5771", // 7.18:1 on white (was #646F91, 4.97:1)
  /** Solid fills for status, each carrying WHITE text at ≥ 7:1. */
  fill: {
    danger: "#AE1A1A", // 7.09:1
    success: "#106430", // 7.27:1
    warning: "#8D4107", // 7.26:1
    external: "#973309", // 7.52:1
    progress: "#6D28D9", // 7.10:1 — already clears it, unchanged
    eco: "#0C625B", // 7.21:1
    neutral: "#3A3F52", // cancelled / no-state
  },
} as const;

export type OutdoorFill = keyof typeof outdoor.fill;

/**
 * Which fill a trip status takes outdoors.
 *
 * ⚠ `cancelled` is NEUTRAL, not danger, and `pending` is WARNING rather than
 * the yellow it wears indoors — but note what is NOT here: nothing maps to
 * `external`. Orange is reserved for offline/queued (owner ruling, 7 Jul), and
 * the external family is one hue away from it. A solid orange status pill
 * outdoors would read as "queued" at a glance, which is the collision this
 * mapping exists to avoid.
 */
export function outdoorFillFor(status: TripStatus): OutdoorFill {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "eco";
    case "assigned":
      return "progress";
    case "in_progress":
      return "progress";
    case "pending_approval":
    case "completed":
      return "success";
    case "cancelled":
      return "neutral";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}
