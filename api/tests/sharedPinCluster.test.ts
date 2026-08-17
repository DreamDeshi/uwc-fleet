import { describe, it, expect } from "vitest";
import {
  classifyCluster,
  streetOf,
  normaliseAddress,
  isCareOfLine,
  keepsPin,
} from "../src/lib/sharedPinCluster";
import { geocodePrecision, isJudgeablePin } from "../src/lib/geocodePrecision";

/**
 * Every fixture here is a REAL SHAPE from the production consignee table
 * (addresses only, no company names — this repo is public). They are the cases
 * that broke the parser twice, kept so a future change has to survive them.
 */
describe("streetOf — the shapes that defeated earlier versions", () => {
  it("reads abbreviations, which the first version could not", () => {
    expect(streetOf("797, JLN PERINDUSTRIAN BUKIT MINYAK 7,MK 13")).toBe(
      "JALAN PERINDUSTRIAN BUKIT MINYAK 7"
    );
    expect(streetOf("PMT 1136,LRG PERINDUSTRIAN BKT MINYAK 20")).toBe(
      "LORONG PERINDUSTRIAN BUKIT MINYAK 20"
    );
  });

  it("reads LINTANG and LENG KOK, which are streets in Penang", () => {
    expect(streetOf("PLOT 82, LINTANG BAYAN LEPAS,BAYAN LEPAS INDUSTRIAL PARK")).toContain(
      "LINTANG BAYAN LEPAS"
    );
    expect(streetOf("102-K, LENG KOK KAMPUNG JAWA DUA,KAWASAN MIEL")).toContain("LENG KOK");
  });

  it("stops at a section word, so trailing detail cannot change the answer", () => {
    // The over-extraction bug: these are the SAME street written two ways, and
    // demanding equality on the greedy result called them different.
    const a = streetOf("797, JLN PERINDUSTRIAN BUKIT MINYAK 7,MK 13, KAW. PERINDUSTRIAN");
    const b = streetOf("797, JALAN PERINDUSTRIAN BUKIT MINYAK 7,");
    expect(a).toBe(b);
  });

  it("keeps the street NUMBER, because 3/7 and 3/10 are different streets", () => {
    expect(streetOf("PMT 777, JALAN CASSIA SELATAN 3/7 TAMAN PERINDUSTRIAN")).toBe(
      "JALAN CASSIA SELATAN 3/7"
    );
    expect(streetOf("PMT 780,JALAN CASSIA SELATAN 3/10,TAMAN PERINDUSTRIAN")).toBe(
      "JALAN CASSIA SELATAN 3/10"
    );
  });

  it("returns null when there is no street to find", () => {
    expect(streetOf("2026, MUKIM 1,PRAI INDUSTRIAL COMPLEX,P.WELLESLEY")).toBeNull();
    expect(streetOf("488 D-4-06, ONE-STOP CENTRE,MIDLANDS PARK,")).toBeNull();
    expect(streetOf("")).toBeNull();
    expect(streetOf(null)).toBeNull();
  });

  it("normalises typos seen in the live data", () => {
    expect(normaliseAddress("Jln Perindutrian Bkt Minyak")).toBe("JALAN PERINDUSTRIAN BUKIT MINYAK");
  });

  it("recognises a C/O line as a company, not a place", () => {
    expect(isCareOfLine("C/O CARGOTEC SWEDEN AB, SPARE PARTS")).toBe(true);
    expect(isCareOfLine("LOT 18,JALAN KELEBANG 1/6")).toBe(false);
  });
});

describe("classifyCluster — positive evidence, or leave it alone", () => {
  it("SAME_ADDRESS when the rows are one address typed differently", () => {
    expect(
      classifyCluster(["756,JALAN BARU JURU,TAMAN IKS JURU,", "NO. 756, JLN. BARU JURU,TMN IKS JURU,"])
    ).toBe("SAME_ADDRESS");
  });

  it("SAME_STREET for units on one street", () => {
    expect(
      classifyCluster([
        "PMT 1136,LRG PERINDUSTRIAN BKT MINYAK 20,TMN PERINDUSTRIAN",
        "PMT 1155, LORONG PERINDUSTRIAN BUKIT MINYAK 20,PENANG SCIENCE PARK",
      ])
    ).toBe("SAME_STREET");
  });

  it("DIFFERENT for two genuinely different streets", () => {
    // ⚠ The case a weaker parser put in the DOWNGRADE pile. Getting this wrong
    // sends a driver to another company's gate.
    expect(
      classifyCluster([
        "102-K, LENG KOK KAMPUNG JAWA DUA,KAWASAN MIEL",
        "101-Q, LINTANG KAMPUNG JAWA,(NON FREE TRADE ZONE)",
      ])
    ).toBe("DIFFERENT");
    expect(
      classifyCluster([
        "PMT 777, JALAN CASSIA SELATAN 3/7 TAMAN PERINDUSTRIAN BATU KAWAN",
        "PMT 780,JALAN CASSIA SELATAN 3/10,TAMAN PERINDUSTRIAN BATU KAWAN,",
      ])
    ).toBe("DIFFERENT");
  });

  it("UNKNOWN when any member cannot be placed at all", () => {
    expect(
      classifyCluster(["LOT 18,JALAN KELEBANG 1/6,ZON PERINDUSTRIAN BEBAS KINTA,", "C/O CARGOTEC SWEDEN AB"])
    ).toBe("UNKNOWN");
    expect(
      classifyCluster(["488B-4-27, 1 STOP MIDLANDS PARK,JALAN BURMAH,", "488 D-4-06, ONE-STOP CENTRE,MIDLANDS PARK,"])
    ).toBe("UNKNOWN");
  });

  it("only the provable verdicts keep their pin", () => {
    expect(keepsPin("SAME_ADDRESS")).toBe(true);
    expect(keepsPin("SAME_STREET")).toBe(true);
    expect(keepsPin("DIFFERENT")).toBe(false);
    expect(keepsPin("UNKNOWN")).toBe(false);
  });
});

describe("what the two verdicts mean downstream", () => {
  it("a kept shared pin is drivable but NEVER judgeable", () => {
    // The whole safety argument. A shared pin is right to within a gate, so it
    // beats a centroid 7.3 km away — and it must never be used to decide that
    // a driver confirmed a delivery from the wrong place.
    expect(geocodePrecision("SHARED_PIN")).toBe("road");
    expect(isJudgeablePin("SHARED_PIN")).toBe(false);
  });

  it("an ambiguous one is neither, and stays distinguishable", () => {
    expect(geocodePrecision("SHARED_PIN_AMBIGUOUS")).toBe("unknown");
    expect(isJudgeablePin("SHARED_PIN_AMBIGUOUS")).toBe(false);
    // ⚠ Distinct values on purpose: a later bulk fix over "demoted duplicates"
    // must find the REASON attached rather than one uniform-looking set.
    expect(geocodePrecision("SHARED_PIN")).not.toBe(geocodePrecision("SHARED_PIN_AMBIGUOUS"));
  });
});
