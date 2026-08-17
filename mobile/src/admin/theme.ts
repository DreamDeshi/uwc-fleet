// UWC corporate design identity — the admin design tokens, ported from
// admin/src/theme.ts for the in-app admin (React Native). colors, radius,
// font and the trip-status maps are VERBATIM; the CSS-only tokens (box-shadow
// strings, linear-gradient strings) are re-expressed in their React Native
// forms: shadows as style objects (shadow* + elevation), gradients as
// color-stop tuples for expo-linear-gradient.
import type { ViewStyle } from "react-native";
import type { TripStatus } from "./types";

/**
 * ── THE SEMANTIC STATUS FAMILY (design handoff, 17 Aug 2026) ───────────────
 *
 * One meaning, one token. The handoff found the same meaning rendering in
 * different shades on different screens — green as #2E7D32, #2A7F24 AND
 * #16A34A; amber as #d97706 and #B45309; the warning tint as both #FFF3E0 and
 * #FFF8E1 — because call sites reached for a hex instead of a token. Every one
 * of those is now an alias of the family below.
 *
 * ⚠ THREE VALUES PER MEANING, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   solid  fills, dots, borders, icon glyphs — the handoff's own hex
 *   tint   the surface a pill or banner sits on — the handoff's own hex
 *   text   SMALL TEXT on that tint, or on white
 *
 * The `text` variant is an addition, not a deviation. The handoff lists one
 * solid per meaning, and several of those solids fail WCAG AA as small text on
 * their own tint (#16A34A on #F0FDF4 is 2.8:1; #D97706 on #FFFBEB is 3.1:1) —
 * which is the exact defect the 4 Aug 2026 accessibility audit fixed and
 * `theme.contrast.test.ts` pins. Adopting the solids as text would have
 * silently reverted that audit while looking like a tidy-up. So the family
 * carries the handoff's colours for everything it named them for, and a
 * darker sibling for the one job it did not: reading.
 *
 * Every pair below is MEASURED in theme.contrast.test.ts, not eyeballed.
 */
export const status = {
  /** Needs attention, alerts, delete. */
  danger: { solid: "#DC2626", tint: "#FEF2F2", text: "#B91C1C" },
  /** Completed, delivered, positive amounts. */
  success: { solid: "#16A34A", tint: "#F0FDF4", text: "#15803D" },
  /** Pending, fuel nudge, K2 customs tag. */
  warning: { solid: "#D97706", tint: "#FFFBEB", text: "#B45309" },
  /** External trips, holidays, route-split "other". */
  external: { solid: "#EA580C", tint: "#FFF7ED", text: "#C2410C" },
  /** Active / in-progress trip badges. */
  progress: { solid: "#7C3AED", tint: "#F5F3FF", text: "#6D28D9" },
  /** Consolidation savings / eco stats. */
  eco: { solid: "#0D9488", tint: "#F0FDFA", text: "#0F766E" },
} as const;

export type StatusFamily = keyof typeof status;

export const colors = {
  blue: "#003087", // Corporate Blue
  yellow: "#FFCC00", // Corporate Yellow
  navy: "#1A1F5E", // sidebar / dark surfaces
  navyDeep: "#10143F", // sidebar gradient tail
  green: status.success.solid,
  // Dark green SURFACE (frame 11's sustainability hero). Not a text colour and
  // not interchangeable with `green`: this is a ground that white type sits on
  // (#fff on #14532D ≈ 10.5:1), where `green` is a 3.00:1 accent that must
  // never carry small text. See theme.contrast.test.ts.
  greenDeep: "#14532D",
  red: status.danger.solid,
  orange: status.external.solid,
  amber: status.warning.solid,
  // ── TEXT-SAFE variants. Mirrors the driver/requestor palette, which was
  // audited on 4 Aug 2026 and gained exactly this split. `amber`, `red` and
  // `orange` above are FILLS, BORDERS AND GLYPHS; none of them clears WCAG AA
  // as small text on its own tint, and every one of them was being used that
  // way somewhere in the admin app. Measured, not estimated:
  //
  //     amber  #d97706 on yellowTint   3.00:1   ← the approvals count pill
  //     orange #F97316 on orangeTint   2.56:1   ← the "No POD" / "No K2" pills
  //     red    #E53935 on redTint      3.70:1   ← the dispatch-bar chips
  //     red    #E53935 on white        4.23:1   ← inline error text
  //
  //     amberText #B45309 on yellowTint 4.73:1 · on orangeTint 4.58:1
  //     redText   #C62828 on redTint    4.92:1 · on white      5.62:1
  //
  // Admins read this indoors, so the sunlight argument that drove the driver
  // audit is weaker here — but "needs attention" text that is hard to read is
  // a poor joke either way, and the pairs are pinned in theme.contrast.test.ts
  // so this cannot quietly regress.
  amberText: status.warning.text,
  redText: status.danger.text,
  violet: status.progress.text, // in-progress (live) status family
  teal: status.eco.text, // approved status family

  bg: "#f5f7fb", // app background
  panel: "#f8f9fc", // table header / muted panel
  card: "#ffffff",
  border: "#e6eaf2",
  divider: "#f0f4f8",

  // Handoff 17 Aug 2026: headline/body text was #1a1a2e here and #1A1F5E in
  // src/theme.ts — "pick one". This is the driver/requestor value, so the two
  // palettes now agree rather than being a shade apart on every screen.
  text: "#1A1F5E",
  textMuted: "#667085",
  textFaint: "#98a2b3",

  // tints
  blueTint: "#EBF3FB",
  greenTint: status.success.tint,
  yellowTint: status.warning.tint,
  orangeTint: status.external.tint,
  redTint: status.danger.tint,
  violetTint: status.progress.tint,
  tealTint: status.eco.tint,
  // Neutral pill family — the "deactivated / retired / not applicable" state,
  // which is deliberately colourless. These were loose hexes repeated across
  // screens; a state that means "no state" still needs ONE definition.
  greyTint: "#F3F4F6",
  greyBorder: "#E5E7EB",
  greyStrong: "#4B5563",
  // Pill borders one step darker than the matching tint, so a tinted pill
  // reads as an object rather than a wash.
  blueBorder: "#BBD2F5",
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

// Type scale (px) — same scale as the web admin ("nothing straining-to-read
// small", 7 Jul 2026).
export const font = {
  xs: 12, // uppercase micro-labels, badges, count pills
  sm: 13, // captions, secondary/muted text
  md: 14, // body, table cells, inputs
  lg: 16, // card/section titles
  xl: 21, // page header title
} as const;

// Box shadows as RN style objects. Android renders via elevation; iOS/web via
// the shadow* properties (React Native Web maps these back to box-shadow).
export const shadow: Record<"card" | "lift" | "floating", ViewStyle> = {
  card: {
    shadowColor: "#000000",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  lift: {
    shadowColor: "#101828",
    shadowOpacity: 0.12,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  floating: {
    shadowColor: "#000000",
    shadowOpacity: 0.12,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
};

// Brand gradients as color-stop tuples for expo-linear-gradient (the web
// admin's linear-gradient() strings, same stops, 135°/180°/90° direction is
// set per-usage via start/end props).
export const gradients = {
  blue: ["#1450BC", "#003087", "#00205C"],
  yellow: ["#FFDB4D", "#FFCC00", "#F2B500"],
  green: ["#55C24C", "#3DAA35", "#2A7F24"],
  red: ["#EF5350", "#E53935", "#B71C1C"],
  sidebar: ["#1A1F5E", "#10143F"],
  header: ["#003087", "#00246B"],
} as const;

// Same-hue soft shadows that pair with the KPI gradients so the tiles float.
export const kpiShadow: Record<"blue" | "yellow" | "green" | "red", ViewStyle> = {
  blue: { shadowColor: "#003087", shadowOpacity: 0.55, shadowRadius: 28, shadowOffset: { width: 0, height: 14 }, elevation: 8 },
  yellow: { shadowColor: "#D69E00", shadowOpacity: 0.55, shadowRadius: 28, shadowOffset: { width: 0, height: 14 }, elevation: 8 },
  green: { shadowColor: "#2E7F24", shadowOpacity: 0.5, shadowRadius: 28, shadowOffset: { width: 0, height: 14 }, elevation: 8 },
  red: { shadowColor: "#B71C1C", shadowOpacity: 0.5, shadowRadius: 28, shadowOffset: { width: 0, height: 14 }, elevation: 8 },
};

// Trip status → swatch. Statuses come from the Prisma TripStatus enum.
// Every lifecycle stage gets its OWN hue (pending amber → approved teal →
// assigned blue → in-progress violet → completed green; cancelled gray,
// rejected red) so a glance at the board separates them without reading —
// the label text is always present, so color is never the only signal.
// Keyed on TripStatus, NOT Record<string, …>. A string-keyed map yields
// `undefined` for a status it has no entry for, and TripStatusBadge fell back to
// the `pending` swatch — so when item 9 added `pending_approval` this map went
// on compiling while painting delivered trips AMBER, as if they were still
// awaiting admin review. Keying on the union makes a missing status a compile
// error instead.
export const tripStatusColor: Record<TripStatus, { bg: string; fg: string; border: string; dot: string }> = {
  pending: { bg: status.warning.tint, fg: status.warning.text, border: "#F0D98A", dot: status.warning.solid },
  approved: { bg: colors.tealTint, fg: colors.teal, border: "#A7DED6", dot: "#14B8A6" },
  assigned: { bg: "#E8F0FE", fg: "#1D4ED8", border: "#BBD2F5", dot: "#2563EB" },
  in_progress: { bg: status.progress.tint, fg: status.progress.text, border: "#D5C8F7", dot: status.progress.solid },
  // Delivered; incentive proposed, awaiting POD approval. The GREEN family —
  // the goods arrived — with a deeper dot than `completed` so the two are
  // distinguishable at a glance on the board without implying a failure. Not
  // orange (the 7 Jul ruling reserves it for offline/queued) and not grey (that
  // is `cancelled`). The label carries the real distinction.
  pending_approval: { bg: status.success.tint, fg: status.success.text, border: "#CCE7C9", dot: status.success.solid },
  completed: { bg: status.success.tint, fg: status.success.text, border: "#CCE7C9", dot: status.success.solid },
  cancelled: { bg: "#F3F4F6", fg: "#4B5563", border: "#E5E7EB", dot: "#9CA3AF" },
  rejected: { bg: status.danger.tint, fg: status.danger.text, border: "#F3C2C0", dot: status.danger.solid },
};

// Status labels are i18n'd in the in-app admin (admin.status.*) — unlike the
// web admin's hardcoded English map. Use tripStatusLabelKey with t().
//
// TripStatus, not `string`: the key is built by interpolation, so a status with
// no `admin.status.*` entry produces a key that resolves to nothing and the
// badge renders the raw enum. That is what shipped — an admin saw the literal
// text "PENDING_APPROVAL" on the board, in all three languages. Narrowing the
// parameter does not by itself prove the i18n key exists (JSON has no type
// relationship to the union), so admin.status is covered by a test instead.
export function tripStatusLabelKey(status: TripStatus): string {
  return `admin.status.${status}`;
}
