// UWC design identity — ported from the Figma prototype + UWC_UI_BRIEF.md.
// Single source of truth for colors, spacing, radius, shadow and type.

import type { TripStatus } from "./types";

export const colors = {
  blue: "#003087", // Corporate Blue (primary)
  blueDark: "#001a4d",
  yellow: "#FFCC00", // accent / pending
  navy: "#1A1F5E", // headings
  bg: "#f4f6fb", // app background
  // Brand green — DECORATIVE ONLY (dots, thin accents, icons on a light
  // background). ⚠ Do NOT put white text on it: white on #3DAA35 is 3.00:1.
  green: "#16A34A",
  // The ACCESSIBLE green, used two ways: as green TEXT on a light background
  // (5.05:1 on white), and as a FILL underneath white text (also 5.05:1 —
  // contrast is symmetric). The 4 Aug 2026 sweep found the original comment
  // here was half right: it moved green NUMBERS off `green`, but left the
  // white-on-green FILLS at 3.00:1 — including the driver's primary "Delivered"
  // button and the completed status pill, both read outdoors in direct sun.
  greenText: "#15803D",
  red: "#E53935", // error — DECORATIVE ONLY, white on it is 4.23:1
  // Red as a FILL under white text (5.62:1). `red` itself falls just short of
  // AA, which is why the danger button and the rejected pill use this instead.
  redDeep: "#C62828",
  orange: "#F97316", // warning / offline-queued — FILLS ONLY, 2.80:1 as text
  // Amber = "pending, someone is looking at it" (owner-approved exception to the
  // orange rule — a reminder, not an offline state). It was hardcoded as
  // #d97706 in six places at 3.19:1; this is the same hue at 5.02:1, and it
  // works as text on white/tints AND as a fill under white text.
  amber: "#d97706", // decorative only — see amberText
  amberText: "#B45309",
  grey: "#64748b", // neutral / cancelled
  violet: "#6D28D9", // in-progress (live) — admin design-system family
  teal: "#0F766E", // approved — admin design-system family
  white: "#ffffff",
  // greys
  text: "#1A1F5E",
  textMuted: "#666666",
  // ⚠ Darkened 4 Aug 2026: #9aa5c4 was 2.46:1 on white — it failed AA outright
  // and was used 146x across 51 files, including `tabBarInactiveTintColor`, so
  // three of four tab labels sat below the line at all times. It had only ever
  // been fixed case by case (see TripDetailsScreen's delivery address). This
  // value is 4.97:1 on white / 4.60:1 on `bg`, and is deliberately kept LIGHTER
  // than textMuted (5.74:1) so the three-tier text hierarchy survives the fix
  // instead of collapsing into two.
  textFaint: "#646F91",
  border: "#e0e4ef",
  borderLight: "#e8ecf4",
  fieldBg: "#f4f6fb",
  tintBlue: "#EBF3FB", // pale blue surface
  tintGreen: "#F0FDF4",
  tintYellow: "#FFFBEB",
  tintOrange: "#FFF3E0",
  tintRed: "#FFEBEE",
  tintViolet: "#EDE9FE",
  tintTeal: "#E0F5F2",
} as const;

// Status → color mapping used across trip/booking badges. SAME semantic hues
// as the admin design system (7 Jul 2026: pending amber · approved teal ·
// assigned blue · in-progress violet · completed green · cancelled gray ·
// rejected red) so a booking reads the same color on the driver's phone and
// the dispatcher's board — but kept as SOLID, high-contrast fills because
// drivers read these outdoors in sunlight. Labels always accompany color.
// Keyed on TripStatus, NOT Record<string, …>. A `Record<string, …>` accepts any
// key, so a status with no entry yields `undefined` and callers silently fall
// back to the "pending" swatch — which is exactly how the admin app ended up
// painting delivered-awaiting-approval trips amber. Keying on the union makes a
// missing status a COMPILE error instead.
export const statusColors: Record<TripStatus, { bg: string; fg: string }> = {
  pending: { bg: colors.yellow, fg: colors.navy },
  approved: { bg: colors.teal, fg: colors.white },
  assigned: { bg: colors.blue, fg: colors.white },
  in_progress: { bg: colors.violet, fg: colors.white },
  // Delivered, incentive proposed, awaiting admin POD approval (money held).
  // GREEN — same as completed — because the goods DID arrive; the outstanding
  // step is an internal pay approval. The distinction is carried by the label
  // ("Awaiting Approval") and, where money is at stake, by the Earnings pending
  // badge. Deliberately not orange (the 7 Jul ruling reserves orange for
  // offline/queued) and not grey (that reads as `cancelled`).
  // ⚠ greenText/redDeep, not green/red: these pills carry WHITE text, and the
  // brand hues are 3.00:1 and 4.23:1 under white. Same hue family, same
  // semantics, same admin parity (the admin board renders these as tinted
  // backgrounds with dark text, so it was never matching these exact values).
  pending_approval: { bg: colors.greenText, fg: colors.white },
  completed: { bg: colors.greenText, fg: colors.white },
  rejected: { bg: colors.redDeep, fg: colors.white },
  cancelled: { bg: colors.grey, fg: colors.white },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

// Max content width for the mobile-first screens (driver / requestor / auth)
// when shown in a desktop browser — the app ships as a web app too, so on a
// wide monitor the content is capped and centered into a phone-like column
// instead of stretching edge-to-edge. On a phone (< these widths) the caps are
// inert. `content` for scrollable screens; `auth` for the login/register card.
export const layout = {
  content: 720,
  // Desktop content cap for the requestor screens (office staff on a PC). Wider
  // than `content` so wide layouts get two comfortable columns instead of a lone
  // phone column stranded in the middle of a 1440px monitor. Gated behind
  // useWide() (≥1024px) so phones never see it.
  wide: 1160,
  auth: 460,
} as const;

// Soft card shadow from the brief: 0 2px 12px rgba(0,0,0,0.06)
export const shadow = {
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  floating: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 10,
  },
} as const;

export const font = {
  // Inter is the design font; we fall back to the system font so the app runs
  // in Expo Go without a custom font-loading step (TODO: bundle Inter for prod).
  weightRegular: "400" as const,
  weightMedium: "600" as const,
  weightBold: "700" as const,
  weightHeavy: "800" as const,
};

// Type scale (px) — mirrors the admin bump (7 Jul 2026): a hard readable
// floor of 12 (drivers read this in sunlight; office staff shouldn't squint
// either). Legacy inline sizes were bulk-aligned: ≤11.5 → 12, 12/12.5 → 13,
// 13/13.5 → 14; 14+ untouched. Use these tokens for new work.
export const type = {
  xs: 12, // badges, micro-labels, chart ticks — the floor
  sm: 13, // captions, secondary/meta text
  md: 14, // body
  lg: 16, // emphasized body / sheet titles
  xl: 20, // screen titles
  hero: 42, // the one big RM figure on a screen
} as const;

// Same-hue action shadows (RN shape; react-native-web maps these to
// box-shadow) — the money buttons float the way admin's filled buttons do.
export const actionShadow = {
  blue: {
    shadowColor: colors.blue,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  yellow: {
    shadowColor: "#D69E00",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  green: {
    shadowColor: "#15803D", // same hue as `greenText`, the fill it sits under
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  red: {
    shadowColor: "#B71C1C",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
} as const;
