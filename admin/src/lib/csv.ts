// Minimal CSV building for the report exports. Cells containing the
// delimiter, quotes or newlines are quoted per RFC 4180 (driver and company
// names go into the payroll export, so this is not optional).
export function csvCell(value: string | number | null | undefined): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}
