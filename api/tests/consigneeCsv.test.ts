import { describe, it, expect } from "vitest";
import { parseCsv, parseConsigneeCsv } from "../src/lib/consigneeCsv";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas-in-quotes and CRLF", () => {
    const g = parseCsv('a,b\r\n"x,y","he said ""hi"""\n');
    expect(g).toEqual([
      ["a", "b"],
      ["x,y", 'he said "hi"'],
    ]);
  });
  it("drops fully-blank lines", () => {
    expect(parseCsv("a,b\n\n,\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseConsigneeCsv", () => {
  it("maps aliased headers and requires company + zone", () => {
    const csv = "Company Name,Zone,Area,Phone\nACME SDN BHD,P1,Bayan Lepas,04-1234567\n,K1,Kulim,\nBETA,K2,,";
    const res = parseConsigneeCsv(csv);
    expect(res.rows).toEqual([
      { company_name: "ACME SDN BHD", zone_code: "P1", area: "Bayan Lepas", phone: "04-1234567" },
      { company_name: "BETA", zone_code: "K2" },
    ]);
    // The middle row is missing a company name → reported, not imported.
    expect(res.errors).toEqual([{ line: 3, reason: "missing company name" }]);
  });

  it("errors when there are no data rows", () => {
    expect(parseConsigneeCsv("Company,Zone").errors.length).toBe(1);
  });
});
