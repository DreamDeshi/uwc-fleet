import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csv cells (payroll export)", () => {
  it("quotes cells containing the delimiter or quotes (names go in the export)", () => {
    expect(csvCell("Mohd Azmi B. Che Dol")).toBe("Mohd Azmi B. Che Dol");
    expect(csvCell("Acme, Sdn Bhd")).toBe('"Acme, Sdn Bhd"');
    expect(csvCell('He said "go"')).toBe('"He said ""go"""');
  });

  it("builds rows with empty cells for null/undefined", () => {
    expect(toCsv([["a", 1], [null, "b"]])).toBe("a,1\n,b");
  });
});
