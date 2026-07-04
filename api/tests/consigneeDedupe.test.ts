import { describe, it, expect } from "vitest";
import { isSimilarCompanyName, pickSimilarCandidates } from "../src/routes/consignees";

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

/**
 * The admin RENAME path (PATCH /consignees/:id) runs the same dedupe as
 * self-add (audit 2026-07-05 #9) — with one twist: the row being renamed must
 * not collide with itself.
 */
describe("pickSimilarCandidates — rename dedupe (self excluded)", () => {
  const rows = [
    { id: "c1", company_name: "ACE ENGINEERING SDN BHD" },
    { id: "c2", company_name: "ACE Engineering" },
    { id: "c3", company_name: "Apex Manufacturing" },
  ];

  it("finds similar actives but never the row being renamed itself", () => {
    const hits = pickSimilarCandidates(rows, "ACE Engineering Sdn Bhd", "c1");
    expect(hits.map((r) => r.id)).toEqual(["c2"]); // c1 excluded, c3 dissimilar
  });

  it("with no excludeId (the create path) all similar rows are candidates", () => {
    const hits = pickSimilarCandidates(rows, "ACE Engineering Sdn Bhd");
    expect(hits.map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("caps the candidate list at 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `x${i}`,
      company_name: "ACE ENGINEERING",
    }));
    expect(pickSimilarCandidates(many, "ACE Engineering")).toHaveLength(5);
  });
});
