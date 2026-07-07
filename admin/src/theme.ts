// UWC corporate design identity — shared tokens used across the admin UI.
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

// Type scale (px). The smallest steps were bumped one notch (7 Jul 2026,
// "nothing straining-to-read small"): badges/micro-labels land at 11.5–12,
// captions/secondary at 12–13, body & table cells at 14. Legacy inline
// sizes across the pages were bulk-aligned to this scale; use these tokens
// for new work so the scale stays the single source of truth.
export const font = {
  xs: 12, // uppercase micro-labels, badges, count pills
  sm: 13, // captions, secondary/muted text
  md: 14, // body, table cells, inputs
  lg: 16, // card/section titles
  xl: 21, // page header title
} as const;

export const shadow = {
  card: "0 2px 12px rgba(0,0,0,0.06)",
  lift: "0 12px 28px rgba(16,24,40,0.12)",
  floating: "0 8px 30px rgba(0,0,0,0.12)",
};

// Brand gradients — depth for the KPI tiles and chrome without leaving the
// corporate palette. Each KPI gradient pairs with a same-hue soft shadow so
// the tiles visibly float off the page.
export const gradients = {
  blue: "linear-gradient(135deg, #1450BC 0%, #003087 60%, #00205C 100%)",
  yellow: "linear-gradient(135deg, #FFDB4D 0%, #FFCC00 55%, #F2B500 100%)",
  green: "linear-gradient(135deg, #55C24C 0%, #3DAA35 60%, #2A7F24 100%)",
  red: "linear-gradient(135deg, #EF5350 0%, #E53935 55%, #B71C1C 100%)",
  sidebar: "linear-gradient(180deg, #1A1F5E 0%, #10143F 100%)",
  header: "linear-gradient(90deg, #003087 0%, #00246B 100%)",
} as const;

export const kpiShadow = {
  blue: "0 14px 28px -12px rgba(0, 48, 135, 0.55)",
  yellow: "0 14px 28px -12px rgba(214, 158, 0, 0.55)",
  green: "0 14px 28px -12px rgba(46, 127, 36, 0.5)",
  red: "0 14px 28px -12px rgba(183, 28, 28, 0.5)",
} as const;

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

// Human-readable status labels.
export const tripStatusLabel: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  assigned: "Assigned",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Rejected",
};
