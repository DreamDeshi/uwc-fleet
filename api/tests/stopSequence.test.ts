import { describe, it, expect } from "vitest";
import { normalizeStopSequences } from "../src/lib/stopSequence";

const ids = (out: { consignee_id: string }[]) => out.map((s) => s.consignee_id);
const seqs = (out: { sequence: number }[]) => out.map((s) => s.sequence);

describe("normalizeStopSequences", () => {
  it("no sequences at all → array order, numbered 1..N", () => {
    // What the requestor app sends, and the behaviour that must not change.
    const out = normalizeStopSequences([{ consignee_id: "a" }, { consignee_id: "b" }, { consignee_id: "c" }]);
    expect(ids(out)).toEqual(["a", "b", "c"]);
    expect(seqs(out)).toEqual([1, 2, 3]);
  });

  it("honours an explicit order, then renumbers it contiguous", () => {
    const out = normalizeStopSequences([
      { consignee_id: "a", sequence: 9 },
      { consignee_id: "b", sequence: 3 },
      { consignee_id: "c", sequence: 5 },
    ]);
    expect(ids(out)).toEqual(["b", "c", "a"]);
    expect(seqs(out)).toEqual([1, 2, 3]);
  });

  it("DUPLICATE sequences are broken by array order, not by the database", () => {
    // The one that matters. Two stops at sequence 1 gave `orderBy: sequence`
    // an undefined winner, so the A1/A2 truck lock read whichever zone Postgres
    // returned first — and both stops derived the SAME Cloudinary POD asset id
    // (`${ticket}-stop-${sequence}`), so one driver's proof overwrote the other's.
    const out = normalizeStopSequences([
      { consignee_id: "ipoh", sequence: 1 },
      { consignee_id: "juru", sequence: 1 },
    ]);
    expect(ids(out)).toEqual(["ipoh", "juru"]);
    expect(seqs(out)).toEqual([1, 2]);
    expect(new Set(seqs(out)).size).toBe(out.length);
  });

  it("a half-filled list is defined, not database-dependent", () => {
    // b has no sequence, so it falls back to its array position (2) — which
    // ties with a's explicit 2. Stable sort keeps a first.
    const out = normalizeStopSequences([
      { consignee_id: "a", sequence: 2 },
      { consignee_id: "b" },
      { consignee_id: "c", sequence: 1 },
    ]);
    expect(ids(out)).toEqual(["c", "a", "b"]);
    expect(seqs(out)).toEqual([1, 2, 3]);
  });

  it("treats an explicit null like an absent sequence", () => {
    const out = normalizeStopSequences([
      { consignee_id: "a", sequence: null },
      { consignee_id: "b", sequence: null },
    ]);
    expect(ids(out)).toEqual(["a", "b"]);
    expect(seqs(out)).toEqual([1, 2]);
  });

  it("carries every other field through untouched", () => {
    const out = normalizeStopSequences([
      { consignee_id: "a", sequence: 2, zone_code: "A2" },
      { consignee_id: "b", sequence: 1, zone_code: "P1" },
    ]);
    expect(out).toEqual([
      { consignee_id: "b", sequence: 1, zone_code: "P1" },
      { consignee_id: "a", sequence: 2, zone_code: "A2" },
    ]);
  });

  it("a single stop and an empty list are both fine", () => {
    expect(normalizeStopSequences([{ consignee_id: "a", sequence: 7 }])).toEqual([
      { consignee_id: "a", sequence: 1 },
    ]);
    expect(normalizeStopSequences([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [{ consignee_id: "a", sequence: 5 }, { consignee_id: "b", sequence: 1 }];
    normalizeStopSequences(input);
    expect(input).toEqual([{ consignee_id: "a", sequence: 5 }, { consignee_id: "b", sequence: 1 }]);
  });
});
