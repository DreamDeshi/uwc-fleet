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
  orange: "#F97316", // warning / assigned
  grey: "#64748b", // neutral / cancelled
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
} as const;

// Status → color mapping used across trip/booking badges. Every status gets a
// DISTINCT swatch so they're tellable apart at a glance in sunlight (audit fix):
//   pending=yellow(wait) · approved=pale-blue · assigned=orange(go) ·
//   in_progress=blue(moving) · completed=green(done) · rejected=red · cancelled=grey
export const statusColors: Record<string, { bg: string; fg: string }> = {
  pending: { bg: colors.yellow, fg: colors.navy },
  approved: { bg: colors.tintBlue, fg: colors.blue },
  assigned: { bg: colors.orange, fg: colors.white },
  in_progress: { bg: colors.blue, fg: colors.white },
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
