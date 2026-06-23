// Display formatting helpers. The API returns money as a Decimal string and
// dates as ISO strings; these turn them into the prototype's display strings.

export function formatMoney(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "RM 0";
  return Number.isInteger(n) ? `RM ${n}` : `RM ${n.toFixed(2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string | Date): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
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
  return { day: String(d.getDate()), mon: MONTHS[d.getMonth()].toUpperCase() };
}

// initials for avatar bubbles, e.g. "Mohd Azmi B. Che Dol" -> "MA"
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
