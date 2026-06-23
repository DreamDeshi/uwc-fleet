// UWC corporate design identity — shared tokens used across the admin UI.
export const colors = {
  blue: "#003087", // Corporate Blue
  yellow: "#FFCC00", // Corporate Yellow
  navy: "#1A1F5E", // sidebar / dark surfaces
  green: "#3DAA35",
  red: "#E53935",
  orange: "#F97316",
  amber: "#d97706", // weekend / pending text

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
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

export const shadow = {
  card: "0 2px 12px rgba(0,0,0,0.06)",
  floating: "0 8px 30px rgba(0,0,0,0.12)",
};

// Trip status → swatch. Statuses come from the Prisma TripStatus enum.
export const tripStatusColor: Record<string, { bg: string; fg: string; border: string; dot: string }> = {
  pending: { bg: colors.yellowTint, fg: colors.amber, border: "#f0d98a", dot: colors.orange },
  approved: { bg: colors.blueTint, fg: colors.blue, border: "#bcd4f0", dot: colors.blue },
  assigned: { bg: colors.blueTint, fg: colors.blue, border: "#bcd4f0", dot: colors.blue },
  in_progress: { bg: colors.blueTint, fg: colors.blue, border: "#bcd4f0", dot: colors.green },
  completed: { bg: colors.greenTint, fg: colors.green, border: "#cce7c9", dot: colors.green },
  cancelled: { bg: "#f3f4f6", fg: "#6b7280", border: "#e5e7eb", dot: "#9ca3af" },
  rejected: { bg: colors.redTint, fg: colors.red, border: "#f3c2c0", dot: colors.red },
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
