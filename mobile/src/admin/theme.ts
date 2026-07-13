// UWC corporate design identity — the admin design tokens, ported from
// admin/src/theme.ts for the in-app admin (React Native). colors, radius,
// font and the trip-status maps are VERBATIM; the CSS-only tokens (box-shadow
// strings, linear-gradient strings) are re-expressed in their React Native
// forms: shadows as style objects (shadow* + elevation), gradients as
// color-stop tuples for expo-linear-gradient.
import type { ViewStyle } from "react-native";

export const colors = {
  blue: "#003087", // Corporate Blue
  yellow: "#FFCC00", // Corporate Yellow
  navy: "#1A1F5E", // sidebar / dark surfaces
  navyDeep: "#10143F", // sidebar gradient tail
  green: "#3DAA35",
  red: "#E53935",
  orange: "#F97316",
  amber: "#d97706", // weekend / pending text
  violet: "#6D28D9", // in-progress (live) status family
  teal: "#0F766E", // approved status family

  bg: "#f5f7fb", // app background
  panel: "#f8f9fc", // table header / muted panel
  card: "#ffffff",
  border: "#e6eaf2",
  divider: "#f0f4f8",

  text: "#1a1a2e",
  textMuted: "#667085",
  textFaint: "#98a2b3",

  // tints
  blueTint: "#EBF3FB",
  greenTint: "#E8F5E9",
  yellowTint: "#FFF8E1",
  orangeTint: "#FFF3E0",
  redTint: "#FFEBEE",
  violetTint: "#EDE9FE",
  tealTint: "#E0F5F2",
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
export const tripStatusColor: Record<string, { bg: string; fg: string; border: string; dot: string }> = {
  pending: { bg: "#FFF3D6", fg: "#A16207", border: "#F0D98A", dot: "#F59E0B" },
  approved: { bg: colors.tealTint, fg: colors.teal, border: "#A7DED6", dot: "#14B8A6" },
  assigned: { bg: "#E8F0FE", fg: "#1D4ED8", border: "#BBD2F5", dot: "#2563EB" },
  in_progress: { bg: colors.violetTint, fg: colors.violet, border: "#D5C8F7", dot: "#8B5CF6" },
  completed: { bg: colors.greenTint, fg: "#2E7D32", border: "#CCE7C9", dot: colors.green },
  cancelled: { bg: "#F3F4F6", fg: "#4B5563", border: "#E5E7EB", dot: "#9CA3AF" },
  rejected: { bg: colors.redTint, fg: "#C62828", border: "#F3C2C0", dot: colors.red },
};

// Status labels are i18n'd in the in-app admin (admin.status.*) — unlike the
// web admin's hardcoded English map. Use tripStatusLabelKey with t().
export function tripStatusLabelKey(status: string): string {
  return `admin.status.${status}`;
}
