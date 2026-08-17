import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  geocodePrecision,
  isJudgeablePin,
  isBrokenAttempt,
  BUILDING_MATCH_TYPES,
  BROKEN_MATCH_TYPES,
  KNOWN_MATCH_TYPES,
} from "../src/lib/geocodePrecision";
import { isStorable, isUsable, geocodeStoreFields } from "../src/lib/geocodeConsignee";
import { earlyTapDistanceM } from "../src/lib/earlyTap";

describe("geocodePrecision — one total mapping over four vocabularies", () => {
  it("grades Google's five location_types", () => {
    expect(geocodePrecision("ROOFTOP")).toBe("building");
    expect(geocodePrecision("RANGE_INTERPOLATED")).toBe("building");
    expect(geocodePrecision("GEOMETRIC_CENTER")).toBe("road");
    expect(geocodePrecision("APPROXIMATE")).toBe("area");
    expect(geocodePrecision("ZERO_RESULTS")).toBe("unknown");
  });

  it("grades the legacy Geoapify rows, which are still in production", () => {
    expect(geocodePrecision("full_match")).toBe("building");
    expect(geocodePrecision("match_by_street")).toBe("road");
    expect(geocodePrecision("match_by_postcode")).toBe("area");
  });

  it("treats a driver's own correction as building-grade", () => {
    // He stood at the gate. That outranks the provider.
    expect(geocodePrecision("driver_fix")).toBe("building");
    expect(isJudgeablePin("driver_fix")).toBe(true);
  });

  it("never promotes an unmapped or absent verdict to building", () => {
    // The direction that matters: a writer we do not know about must not be
    // able to make itself judgeable. Navigable, yes — judgeable, no.
    expect(geocodePrecision("SOME_FUTURE_PROVIDER_VERDICT")).toBe("unknown");
    expect(geocodePrecision(null)).toBe("unknown");
    expect(geocodePrecision(undefined)).toBe("unknown");
    expect(geocodePrecision("")).toBe("unknown");
    expect(isJudgeablePin("SOME_FUTURE_PROVIDER_VERDICT")).toBe(false);
  });

  it("tolerates whitespace, since these are provider strings", () => {
    expect(geocodePrecision("  ROOFTOP  ")).toBe("building");
  });

  it("covers every vocabulary — a dropped one is a silent mis-grade", () => {
    // POSITIVE CONTROL. `KNOWN_MATCH_TYPES` is derived from the table, so an
    // emptied or truncated table would otherwise make every assertion below
    // vacuously true. Name the three writers explicitly.
    expect(KNOWN_MATCH_TYPES.length).toBeGreaterThan(12);
    for (const google of ["ROOFTOP", "RANGE_INTERPOLATED", "GEOMETRIC_CENTER", "APPROXIMATE"]) {
      expect(KNOWN_MATCH_TYPES, `Google: ${google}`).toContain(google);
    }
    for (const geoapify of ["full_match", "match_by_street", "match_by_postcode"]) {
      expect(KNOWN_MATCH_TYPES, `Geoapify: ${geoapify}`).toContain(geoapify);
    }
    expect(KNOWN_MATCH_TYPES).toContain("driver_fix");
  });

  it("BUILDING_MATCH_TYPES is non-empty and is exactly the building set", () => {
    // A derived DB filter that came out empty would select NOTHING and read as
    // "no rows qualify" — a guard degraded by its own data. Pin it non-empty.
    expect(BUILDING_MATCH_TYPES.length).toBeGreaterThan(0);
    expect(BUILDING_MATCH_TYPES).toContain("ROOFTOP");
    for (const t of BUILDING_MATCH_TYPES) expect(geocodePrecision(t)).toBe("building");
    for (const t of KNOWN_MATCH_TYPES) {
      if (geocodePrecision(t) === "building") expect(BUILDING_MATCH_TYPES).toContain(t);
    }
  });
});

describe("the store gate now keeps a POSITION, not only a building", () => {
  it("stores road-level and area-level coordinates that used to be discarded", () => {
    // This is the 349 production consignees: they had an answer, and we threw
    // it away in favour of a zone centroid up to 26.94 km out.
    expect(isStorable("GEOMETRIC_CENTER")).toBe(true);
    expect(isStorable("APPROXIMATE")).toBe(true);
    expect(geocodeStoreFields({ lat: 5.3, lng: 100.4, locationType: "GEOMETRIC_CENTER" })).toEqual({
      latitude: 5.3,
      longitude: 100.4,
      geocode_match_type: "GEOMETRIC_CENTER",
    });
  });

  it("still refuses a NON-answer — there is no position to store", () => {
    expect(isStorable("ZERO_RESULTS")).toBe(false);
    expect(isStorable("RETRY_EXHAUSTED")).toBe(false);
    expect(geocodeStoreFields({ lat: null, lng: null, locationType: "ZERO_RESULTS" })).toEqual({
      latitude: null,
      longitude: null,
      geocode_match_type: "ZERO_RESULTS",
    });
  });

  it("keeps BUILDING as its own idea, distinct from storable", () => {
    // The two gates diverge deliberately: storable is about navigation, usable
    // is about judgement. If these ever collapse back into one predicate, the
    // early-tap report starts measuring drivers against street centres.
    expect(isUsable("GEOMETRIC_CENTER")).toBe(false);
    expect(isStorable("GEOMETRIC_CENTER")).toBe(true);
  });
});

describe("earlyTap judges BUILDING pins only", () => {
  const deliveredAt = new Date("2026-08-18T02:00:00Z");
  // A fix ~1.2 km from the consignee — comfortably beyond the 500 m radius.
  const fixes = [{ latitude: 5.3, longitude: 100.4, recorded_at: deliveredAt }];
  const far = { latitude: 5.311, longitude: 100.4 };

  it("still measures a rooftop pin, exactly as before", () => {
    const d = earlyTapDistanceM(deliveredAt, fixes, { ...far, geocode_match_type: "ROOFTOP" }, 10);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(500);
  });

  it("declines to measure a road-level pin", () => {
    // The whole point. Widening the store gate hands this module ~349 coarse
    // pins; measuring a driver against a street centre at a 500 m radius would
    // put honest drivers on an admin list.
    expect(
      earlyTapDistanceM(deliveredAt, fixes, { ...far, geocode_match_type: "GEOMETRIC_CENTER" }, 10)
    ).toBeNull();
    expect(
      earlyTapDistanceM(deliveredAt, fixes, { ...far, geocode_match_type: "APPROXIMATE" }, 10)
    ).toBeNull();
  });

  it("declines an ungraded pin rather than assuming it is good", () => {
    expect(earlyTapDistanceM(deliveredAt, fixes, { ...far, geocode_match_type: null }, 10)).toBeNull();
  });
});

describe("WIRING: the report's query actually reaches the new gate", () => {
  /**
   * ⚠ THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT THE REAL BUG.
   *
   * `earlyTapDistanceM` now reads `consignee.geocode_match_type`. The only
   * caller selects its consignee columns explicitly, and that select did NOT
   * include the column — so every row would have arrived ungraded, every call
   * would have returned null, and the entire early-tap report would have gone
   * silently empty while every unit test above stayed green. An empty review
   * list looks exactly like a clean week.
   *
   * Asserted on SOURCE because the failure is what the QUERY asks for, and the
   * unit tests construct their consignee objects by hand — they can never see
   * a missing column. Comments are stripped first: a source guard that reads
   * comments is satisfied by a comment merely mentioning the thing (and the
   * negative direction below would go red on the note explaining it).
   */
  const raw = readFileSync(join(__dirname, "..", "src", "routes", "reports.ts"), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("selects geocode_match_type for the early-tap candidates", () => {
    expect(src.length, "reports.ts moved or was renamed").toBeGreaterThan(1000);
    expect(src, "the early-tap query must still exist").toContain("earlyTapDistanceM(");
    const select = src.slice(src.indexOf("const candidateStops"), src.indexOf("earlyTapDistanceM("));
    expect(select.length, "the query and its caller drifted apart").toBeGreaterThan(200);
    expect(select, "without this column every row reads as ungraded").toContain(
      "geocode_match_type: true"
    );
  });

  it("filters on the building set at the database, not by hand", () => {
    const select = src.slice(src.indexOf("const candidateStops"), src.indexOf("earlyTapDistanceM("));
    expect(select).toContain("BUILDING_MATCH_TYPES");
  });
});

describe("the BATCH script and creation-time geocoding apply the SAME store gate", () => {
  /**
   * ⚠ THE DEFECT THIS EXISTS FOR, FOUND 18 Aug 2026 — hours after the gate was
   * widened everywhere else.
   *
   * `geocodeStoreFields` (creation-time) and `scripts/geocode-google.ts`'s write
   * loop are two implementations of one decision: does this answer get stored?
   * The script wrote its own `keep` expression instead of calling the shared
   * helper, so when the gate widened, only creation-time moved. A re-run would
   * then have discarded exactly the coarse answers the change existed to keep —
   * and reported "consignees updated: 25" while doing it.
   *
   * That is the absence-looks-like-success shape again, in its nastiest form: a
   * WRITE that reports success having written nothing useful. No count would
   * have looked wrong.
   *
   * Asserted on SOURCE because the two live in different modules and the script
   * is a CLI with a live API call in the middle — there is no seam to unit test.
   * Comments are stripped first: this file's own header quotes the old
   * expression, and a guard that reads comments punishes the explanation.
   */
  const raw = readFileSync(join(__dirname, "..", "scripts", "geocode-google.ts"), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the batch write loop gates on isStorable, not on isUsable", () => {
    expect(src.length, "the script moved or was renamed").toBeGreaterThan(2000);
    const write = src.slice(src.indexOf("if (!DRY_RUN)"));
    expect(write.length, "the write block is gone — this guard is now vacuous").toBeGreaterThan(200);
    expect(write, "a keep decision must exist to check").toContain("const keep =");
    expect(write, "isStorable is the store gate").toContain("isStorable(r.location_type)");
    expect(write, "isUsable is BUILDING grade — using it here discards road pins").not.toContain(
      "isUsable(r.location_type) && r.lat"
    );
  });

  it("captures the provider's coordinate UNGATED — the gate is at the write", () => {
    /**
     * ⚠ THE SECOND HALF OF THE SAME DEFECT, and the half that made the first
     * fix useless. The capture line read `lat: usable ? g.lat : null`, so the
     * road-level coordinates were destroyed before any gate could keep them.
     * Widening the write gate changed nothing, the --out dump was already
     * lossy, and the A1 dry run reported "will hold coordinates: 16" against
     * sixteen null latitudes.
     *
     * One decision, implemented in THREE places (capture, write, summary), and
     * the earliest one silently outranked the other two.
     */
    const capture = src.slice(src.indexOf("perRow.push({"), src.indexOf("if (OUT)"));
    expect(capture.length, "the capture block moved").toBeGreaterThan(50);
    expect(capture, "the coordinate must be captured as given").toContain("lat: g.lat");
    expect(capture, "gating at capture destroys what the write gate would keep").not.toContain(
      "lat: usable ? g.lat"
    );
  });

  it("counts storable rows by COORDINATE, not by verdict", () => {
    // A storable location_type with a null lat stores nothing. Counting
    // verdicts overstated the A1 run by 16 — a summary promising coordinates
    // the write could not deliver.
    expect(src).toContain("isStorable(r.location_type) && r.lat != null");
  });

  it("still demotes duplicate BUILDING pins — the backstop is unchanged", () => {
    // Widening the store gate must not widen the duplicate demotion: that
    // backstop is about coordinates precise enough that two identical ones mean
    // the geocoder gave up, which is a statement about building grade only.
    expect(src).toContain("if (isUsable(m.location_type)) demotedIds.add(m.id)");
  });
});

describe("a BROKEN lookup is distinguishable from one that never ran", () => {
  /**
   * THE DEFECT. `geocodeNewConsignee` returned early with a bare `return` when
   * GOOGLE_MAPS_KEY was absent, and wrote nothing at all when the call threw.
   * Either way the row was left exactly as if nothing had been attempted:
   * null coords, null match_type.
   *
   * `/consignees/coverage` reads a null match_type as NEVER GEOCODED, and the
   * admin screen then says "a geocode run would fill it". With no key that is
   * confidently wrong advice, it gets more wrong with every consignee added,
   * and NOTHING anywhere reports that geocoding is not running. A misconfigured
   * production instance looks exactly like a well-configured one with some
   * awkward addresses.
   *
   * Same family as the empty early-tap report: absence indistinguishable from
   * success, and the fix is to make the empty state say WHICH nothing it is.
   */
  it("separates a broken lookup from a genuine 'address not found'", () => {
    // ZERO_RESULTS is a real answer: the geocoder read the address and could
    // not place it. Another run returns the same thing — fix the ADDRESS.
    expect(isBrokenAttempt("ZERO_RESULTS")).toBe(false);
    // These never reached a verdict — fix the SYSTEM.
    for (const v of ["NO_API_KEY", "ERROR", "RETRY_EXHAUSTED", "OVER_QUERY_LIMIT", "REQUEST_DENIED"]) {
      expect(isBrokenAttempt(v), v).toBe(true);
    }
  });

  it("does not call an untouched row broken", () => {
    // A null match_type means NEVER ATTEMPTED, which is a different problem
    // with different advice. Conflating the two is the bug, in reverse.
    expect(isBrokenAttempt(null)).toBe(false);
    expect(isBrokenAttempt(undefined)).toBe(false);
    expect(isBrokenAttempt("")).toBe(false);
  });

  it("grades every broken verdict as unknown, so none can be navigated to", () => {
    for (const v of BROKEN_MATCH_TYPES) expect(geocodePrecision(v), v).toBe("unknown");
  });

  it("BROKEN_MATCH_TYPES is non-empty — an empty filter would count zero forever", () => {
    // POSITIVE CONTROL. This list becomes a database `in` filter. Emptied, the
    // count is always 0 and the screen silently reports "nothing broken",
    // which is the exact failure this whole feature exists to remove.
    expect(BROKEN_MATCH_TYPES.length).toBeGreaterThan(4);
    expect(BROKEN_MATCH_TYPES).toContain("NO_API_KEY");
  });

  describe("WIRING: the silent paths actually record a verdict", () => {
    /**
     * Asserted on SOURCE. The no-key path is an early return inside a
     * fire-and-forget function with no seam to observe, and the catch path only
     * runs when a live HTTP call throws. A unit test can reach neither without
     * standing up Prisma and the network, and the thing that broke was not the
     * logic — it was that NOTHING WAS WRITTEN. Comments stripped, because the
     * code now explains the old `return` at length.
     */
    const raw = readFileSync(join(__dirname, "..", "src", "lib", "geocodeConsignee.ts"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    it("the missing-key path records NO_API_KEY instead of returning silently", () => {
      expect(src.length, "the module moved or was renamed").toBeGreaterThan(1000);
      expect(src, "a bare early return leaves the row looking untouched").not.toMatch(
        /if \(!key\) return;/
      );
      expect(src).toContain('recordVerdict(c.id, "NO_API_KEY")');
    });

    it("the catch path records ERROR instead of only logging", () => {
      const katch = src.slice(src.indexOf("} catch (err) {"));
      expect(katch.length, "the catch block moved").toBeGreaterThan(50);
      expect(katch).toContain('recordVerdict(c.id, "ERROR")');
    });

    it("recording is FILL-ONLY, so it can never erase a coordinate", () => {
      // The verdict write must not overwrite a position that arrived meanwhile
      // from an admin fix, a batch run or the self-heal.
      const fn = src.slice(src.indexOf("async function recordVerdict"));
      expect(fn).toContain("latitude: null, longitude: null");
    });
  });
});
