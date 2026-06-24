// Display formatting helpers. The API returns money as a Decimal string and
// dates as ISO strings; these turn them into the prototype's display strings.
import i18n from "i18next";

export function formatMoney(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "RM 0";
  return Number.isInteger(n) ? `RM ${n}` : `RM ${n.toFixed(2)}`;
}

// ── Localised month names ────────────────────────────────────────────────
// Dates used to render English-only (hardcoded month arrays). We now derive
// month names from the active language via Intl, falling back to English if the
// runtime lacks Intl data. Results are cached per language+style.
const FALLBACK_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FALLBACK_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const monthCache: Record<string, string[]> = {};

function monthNames(style: "short" | "long"): string[] {
  const lang = i18n.language === "ms" ? "ms" : "en";
  const key = `${lang}-${style}`;
  if (monthCache[key]) return monthCache[key];
  let names: string[];
  try {
    const tag = lang === "ms" ? "ms-MY" : "en-GB";
    const fmt = new Intl.DateTimeFormat(tag, { month: style });
    names = Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2021, i, 15))));
  } catch {
    names = style === "long" ? FALLBACK_LONG : FALLBACK_SHORT;
  }
  monthCache[key] = names;
  return names;
}

export function formatDate(iso: string | Date): string {
  const d = new Date(iso);
  return `${d.getDate()} ${monthNames("short")[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatTime(iso: string | Date): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function formatDateTime(iso: string | Date): string {
  return `${formatDate(iso)}, ${formatTime(iso)}`;
}

export function dayMonth(iso: string | Date): { day: string; mon: string } {
  const d = new Date(iso);
  return { day: String(d.getDate()), mon: monthNames("short")[d.getMonth()].toUpperCase() };
}

// "YYYY-MM" -> localised "June 2026" (used by the Earnings summary).
export function monthYear(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return `${monthNames("long")[m - 1]} ${y}`;
}

// initials for avatar bubbles, e.g. "Driver 1" -> "MA"
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
