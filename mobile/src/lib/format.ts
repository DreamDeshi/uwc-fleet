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

// App languages are exactly en/ms/zh (Profile picker); zh previously fell
// through to English on the Earnings summary and every date line.
function activeLang(): "en" | "ms" | "zh" {
  const l = i18n.language ?? "en";
  return l.startsWith("ms") ? "ms" : l.startsWith("zh") ? "zh" : "en";
}

const INTL_TAGS = { en: "en-GB", ms: "ms-MY", zh: "zh-CN" } as const;

function monthNames(style: "short" | "long"): string[] {
  const lang = activeLang();
  const key = `${lang}-${style}`;
  if (monthCache[key]) return monthCache[key];
  let names: string[];
  try {
    const fmt = new Intl.DateTimeFormat(INTL_TAGS[lang], { month: style });
    names = Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2021, i, 15))));
  } catch {
    names = style === "long" ? FALLBACK_LONG : FALLBACK_SHORT;
  }
  monthCache[key] = names;
  return names;
}

// Mon-first short weekday labels (the Earnings chart axis), localised the same
// way as monthNames instead of a hardcoded English array.
const FALLBACK_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const weekdayCache: Record<string, string[]> = {};

export function weekdayShortNames(): string[] {
  const lang = activeLang();
  if (weekdayCache[lang]) return weekdayCache[lang];
  let names: string[];
  try {
    const fmt = new Intl.DateTimeFormat(INTL_TAGS[lang], { weekday: "short", timeZone: "UTC" });
    // 2021-03-01 was a Monday; +i days walks Mon → Sun.
    names = Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2021, 2, 1 + i))));
  } catch {
    names = FALLBACK_WEEKDAYS;
  }
  weekdayCache[lang] = names;
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

// initials for avatar bubbles, e.g. "Mohd Ali B. Abu" -> "MA"
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
