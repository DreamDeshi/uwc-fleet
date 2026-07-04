// Formatting helpers. Money is stored as a Prisma Decimal (serialised as a
// string) or computed as a number — both are coerced via Number() here.

export function formatMoney(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function formatNumber(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString("en-MY");
}

// All human-readable dates/times render in MYT (the timezone every business
// rule — off-peak cutoff, day ledger, leave — is computed in), NOT the
// browser's local timezone. An admin on a mis-set or overseas machine must
// see the same instants the server bills by. Times carry an explicit "MYT"
// label so boundary evidence (e.g. an 18:05 delivery) is unambiguous.
const MYT = "Asia/Kuala_Lumpur";

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: MYT,
  });
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  const t = d.toLocaleTimeString("en-MY", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: MYT,
  });
  return `${t} MYT`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return `${formatDate(value)}, ${formatTime(value)}`;
}

// The MYT (UTC+8) calendar day of an instant as "YYYY-MM-DD" — the key format
// the API's holiday/leave calendars use. Computed with a fixed offset, NOT the
// browser's local timezone.
export function mytDateKey(value: string | Date): string {
  const myt = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000);
  return myt.toISOString().slice(0, 10);
}

export function formatFullDate(value: Date): string {
  return value.toLocaleDateString("en-MY", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: MYT,
  });
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function relativeExpiry(daysLeft: number): string {
  if (daysLeft < 0) return `Expired ${Math.abs(daysLeft)}d ago`;
  if (daysLeft === 0) return "Expires today";
  return `Expires in ${daysLeft}d`;
}
