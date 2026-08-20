import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * `GET /consignees` returns `has_position` so the admin directory can say which
 * addresses sit at a real building and which fall back to the zone centre. At
 * the last production read that was 1,160 of 1,562 placed and **402 area-level**
 * — about one row in four, so the indicator is a normal condition, not an alarm.
 *
 * ⚠ WHY THIS IS A TEST AND NOT A CODE REVIEW. The endpoint has TWO query
 * branches — raw SQL when the admin is searching, Prisma `findMany` when they
 * are browsing. A field added to one and not the other gives an indicator that
 * works on the browse list and silently reads "area only" for every search
 * result. And if the source column is dropped from either, every row comes back
 * unplaced — which is indistinguishable from a directory with no positions at
 * all. That is the failure this repository keeps shipping: the query stopped
 * carrying the column the gate reads, and an empty answer looked like a clean
 * one.
 *
 * So: assert the REACH. Prove it by deleting the column from either branch, not
 * by breaking the boolean.
 */
describe("GET /consignees carries has_position on BOTH query branches", () => {
  /**
   * ⚠ STRIP COMMENTS FIRST. The comments in that route deliberately NAME
   * `has_position`, `latitude` and `longitude` to explain the rule — so a scan
   * that reads them is satisfied by the documentation while the code does
   * nothing. Same helper as mobile/src/lib/mytDay.test.ts.
   */
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const src = codeOnly(
    fs.readFileSync(path.resolve(__dirname, "../src/routes/consignees.ts"), "utf-8")
  );

  it("is the file this guard thinks it is", () => {
    // POSITIVE CONTROL. An empty or moved file matches no forbidden pattern and
    // would satisfy every assertion below by having nothing in it.
    expect(src.length, "consignees.ts moved or was renamed").toBeGreaterThan(4000);
    expect(src, "this is not the consignee list route").toContain('router.get("/"');
  });

  it("the SEARCH branch derives it in SQL", () => {
    expect(
      src.replace(/\s+/g, " "),
      "the raw SQL SELECT no longer computes has_position"
    ).toContain("(c.latitude IS NOT NULL AND c.longitude IS NOT NULL) AS has_position");
  });

  it("the BROWSE branch selects the columns it derives from", () => {
    // The Prisma select must carry BOTH coordinates. Dropping either one makes
    // the derived boolean false for every row, quietly.
    const select = src.slice(src.indexOf("const head = await prisma.consignee.findMany"));
    expect(select.length, "the browse branch moved").toBeGreaterThan(200);
    expect(select, "latitude is not selected").toContain("latitude: true");
    expect(select, "longitude is not selected").toContain("longitude: true");
    expect(select, "has_position is not derived").toContain(
      "has_position: c.latitude !== null && c.longitude !== null"
    );
  });

  it("the response actually returns it", () => {
    // A field computed on both branches and then dropped from res.json is the
    // same defect wearing a third hat.
    const body = src.slice(src.indexOf("res.json("));
    expect(body.length, "the response mapping moved").toBeGreaterThan(200);
    expect(body, "has_position is computed but never sent").toContain("has_position: r.has_position");
  });

  it("never derives precision from geocode_match_type", () => {
    // That column holds two provider vocabularies depending on which script last
    // wrote the row, so it cannot answer "is this a building?". The write-time
    // gate stores NULL coordinates for anything coarse; coord presence IS the
    // verdict. types.ts says the same to the client.
    const listRoute = src.slice(src.indexOf('router.get("/"'), src.indexOf("similarActiveConsignees"));
    expect(listRoute.length, "the list route moved").toBeGreaterThan(500);
    expect(listRoute, "the list must not read geocode_match_type").not.toContain("geocode_match_type");
  });
});
