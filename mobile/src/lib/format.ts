// Display formatting helpers. The API returns money as a Decimal string and
// dates as ISO strings; these turn them into the prototype's display strings.
import i18n from "i18next";

// ⚠ Found in code review 31 Aug 2026: this used to print a WHOLE number with
// no decimals ("RM 44") and only switch to 2dp for a non-integer amount
// ("RM 44.55"), while admin/lib/format.ts's formatMoney is ALWAYS 2dp — whose
// own comment already explains why: "payroll columns are reconciled
// line-by-line, and mixed RM 44 / RM 44.5 / RM 44.55 is ambiguous (is 'RM 44'
// exactly 44.00?)." That reasoning does not stop applying just because the
// screen is the driver's Earnings rather than the admin's approval queue — a
// driver and the admin approving the SAME stop's incentive could see
// differently-formatted figures for the identical number. Always 2dp here
// too, matching admin's format exactly.
export function formatMoney(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "RM 0.00";
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/** Whole minutes from `now` until `iso`. Negative once the moment has passed. */
export function minutesUntil(iso: string | Date, now: Date = new Date()): number {
  return Math.round((+new Date(iso) - +now) / 60000);
}

/**
 * "in 40 min" / "in 1 h 25 min" for the pickup time on the driver's Home card.
 * Returns null once the pickup time is past (or a day or more away) — the card
 * always shows the absolute time too, so there is nothing to fall back to and
 * "in -20 min" would be worse than silence.
 */
export function relativeStart(iso: string | Date, now: Date = new Date()): string | null {
  const mins = minutesUntil(iso, now);
  if (mins <= 0 || mins >= 24 * 60) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return i18n.t("driver.inMinutes", { n: m });
  if (m === 0) return i18n.t("driver.inHours", { h });
  return i18n.t("driver.inHoursMinutes", { h, m });
}

// initials for avatar bubbles, e.g. "Mohd Ali B. Abu" -> "MA"
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
