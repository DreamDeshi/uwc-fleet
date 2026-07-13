// Minimal CSV building for the report exports. Cells containing the
// delimiter, quotes or newlines are quoted per RFC 4180 (driver and company
// names go into the payroll export, so this is not optional).
export function csvCell(value: string | number | null | undefined): string {
  let s = String(value ?? "");
  // Excel formula-injection guard: a TEXT cell starting with = + - or @
  // executes as a formula when the clerk opens the sheet, and names are free
  // text (requestor self-adds, admin entry) — neutralise with a leading
  // apostrophe, which Excel renders as plain text. Only strings: a genuine
  // negative NUMBER cell must stay a number.
  if (typeof value === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

/**
 * UTF-8 byte-order mark. Excel (the clerk's tool, double-clicking the file)
 * decodes a BOM-less CSV as ANSI and mojibakes any non-ASCII name — prefix
 * every exported blob with this.
 */
export const CSV_BOM = "\uFEFF";
