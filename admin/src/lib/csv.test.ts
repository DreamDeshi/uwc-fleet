import { describe, expect, it } from "vitest";
import { csvCell, toCsv, CSV_BOM } from "./csv";

describe("csv cells (payroll export)", () => {
  it("quotes cells containing the delimiter or quotes (names go in the export)", () => {
    expect(csvCell("Mohd Azmi B. Che Dol")).toBe("Mohd Azmi B. Che Dol");
    expect(csvCell("Acme, Sdn Bhd")).toBe('"Acme, Sdn Bhd"');
    expect(csvCell('He said "go"')).toBe('"He said ""go"""');
  });

  it("builds rows with empty cells for null/undefined", () => {
    expect(toCsv([["a", 1], [null, "b"]])).toBe("a,1\n,b");
  });

  it("quotes embedded newlines (multi-line addresses stay one cell)", () => {
    expect(csvCell("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
    expect(csvCell("CR\rLF")).toBe('"CR\rLF"');
  });

  it("neutralises Excel formula injection (leading = + - @) with an apostrophe", () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("numeric cells are untouched — a negative NUMBER stays a number", () => {
    expect(csvCell(144)).toBe("144");
    expect(csvCell(-44)).toBe("-44"); // only string inputs get the guard
    expect(csvCell("144.00")).toBe("144.00");
  });

  it("CSV_BOM is exactly the UTF-8 byte-order mark Excel needs", () => {
    expect(CSV_BOM.length).toBe(1);
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});
