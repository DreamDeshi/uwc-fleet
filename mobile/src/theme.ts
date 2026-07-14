// UWC design identity — ported from the Figma prototype + UWC_UI_BRIEF.md.
// Single source of truth for colors, spacing, radius, shadow and type.

export const colors = {
  blue: "#003087", // Corporate Blue (primary)
  blueDark: "#001a4d",
  yellow: "#FFCC00", // accent / pending
  navy: "#1A1F5E", // headings
  bg: "#f4f6fb", // app background
  green: "#3DAA35", // success / completed
  red: "#E53935", // error / rejected
  orange: "#F97316", // warning / offline-queued
  grey: "#64748b", // neutral / cancelled
  violet: "#6D28D9", // in-progress (live) — admin design-system family
  teal: "#0F766E", // approved — admin design-system family
  white: "#ffffff",
  // greys
  text: "#1A1F5E",
  textMuted: "#666666",
  textFaint: "#9aa5c4",
  border: "#e0e4ef",
  borderLight: "#e8ecf4",
  fieldBg: "#f4f6fb",
  tintBlue: "#EBF3FB", // pale blue surface
  tintGreen: "#E8F5E9",
  tintYellow: "#FFF8E1",
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
export const statusColors: Record<string, { bg: string; fg: string }> = {
  pending: { bg: colors.yellow, fg: colors.navy },
  approved: { bg: colors.teal, fg: colors.white },
  assigned: { bg: colors.blue, fg: colors.white },
  in_progress: { bg: colors.violet, fg: colors.white },
  completed: { bg: colors.green, fg: colors.white },
  rejected: { bg: colors.red, fg: colors.white },
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
    shadowColor: "#2A7F24",
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
