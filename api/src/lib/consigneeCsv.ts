/**
 * Consignee CSV import parser (pure, unit-testable). Turns pasted/uploaded CSV
 * text into validated consignee rows, tolerating quoted fields and a flexible
 * header (common aliases). company_name + zone_code are required; everything
 * else is optional. Validation of the zone against the DB happens at the route.
 */

/** Minimal RFC-4180-ish CSV: handles quotes, escaped quotes, and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const HEADER_ALIASES: Record<string, string> = {
  company: "company_name",
  "company name": "company_name",
  name: "company_name",
  zone: "zone_code",
  "zone code": "zone_code",
  contact: "contact_person",
  "contact person": "contact_person",
  phone: "phone",
  tel: "phone",
  area: "area",
  state: "state",
  address: "address_1",
  "address 1": "address_1",
  address1: "address_1",
  "address 2": "address_2",
  address2: "address_2",
  postcode: "postal_code",
  "postal code": "postal_code",
  zip: "postal_code",
};

export interface ParsedConsigneeRow {
  company_name: string;
  zone_code: string;
  contact_person?: string;
  phone?: string;
  area?: string;
  state?: string;
  address_1?: string;
  address_2?: string;
  postal_code?: string;
}

export interface ConsigneeCsvResult {
  rows: ParsedConsigneeRow[];
  errors: { line: number; reason: string }[];
}

export function parseConsigneeCsv(text: string): ConsigneeCsvResult {
  const grid = parseCsv(text);
  if (grid.length < 2) return { rows: [], errors: [{ line: 0, reason: "No data rows (need a header row + at least one row)." }] };

  const header = grid[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim().toLowerCase());
  const rows: ParsedConsigneeRow[] = [];
  const errors: { line: number; reason: string }[] = [];

  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    const rec: Record<string, string> = {};
    header.forEach((key, idx) => {
      const v = (cells[idx] ?? "").trim();
      if (v) rec[key] = v;
    });
    if (!rec.company_name) {
      errors.push({ line: i + 1, reason: "missing company name" });
      continue;
    }
    if (!rec.zone_code) {
      errors.push({ line: i + 1, reason: "missing zone" });
      continue;
    }
    rows.push(rec as unknown as ParsedConsigneeRow);
  }
  return { rows, errors };
}
