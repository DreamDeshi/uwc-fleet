import { describe, it, expect } from "vitest";
import { isSimilarCompanyName } from "../src/routes/consignees";

/**
 * Consignee self-add dedupe: two names are similar when their normalised
 * (lowercase, alphanumeric-only) forms are equal or one contains the other
 * (4+ chars). This is what turns "A.C.E Sdn Bhd" vs "ACE SDN. BHD." into a
 * 409 SIMILAR_EXISTS warning instead of a silent near-duplicate.
 */
describe("isSimilarCompanyName", () => {
  it("matches punctuation/spacing variants of the same name", () => {
    expect(isSimilarCompanyName("A.C.E Sdn Bhd", "ACE SDN. BHD.")).toBe(true);
    expect(isSimilarCompanyName("ace sdn bhd", "A C E SDN BHD")).toBe(true);
  });

  it("matches when one name contains the other (suffix added/dropped)", () => {
    expect(isSimilarCompanyName("ACE Engineering", "ACE ENGINEERING SDN BHD")).toBe(true);
    expect(isSimilarCompanyName("Penang Logistics Sdn Bhd", "Penang Logistics")).toBe(true);
  });

  it("does not match unrelated companies", () => {
    expect(isSimilarCompanyName("ACE Engineering", "Apex Manufacturing")).toBe(false);
    expect(isSimilarCompanyName("Northern Steel", "Southern Steelworks Sdn Bhd")).toBe(false);
  });

  it("short names (<4 normalised chars) only match exactly, not by containment", () => {
    expect(isSimilarCompanyName("ACE", "A.C.E")).toBe(true); // exact after normalise
    expect(isSimilarCompanyName("ACE", "SPACEX LOGISTICS")).toBe(false); // no substring match at <4
  });

  it("empty/punctuation-only names never match", () => {
    expect(isSimilarCompanyName("---", "ACE")).toBe(false);
  });
});
