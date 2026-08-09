import { describe, it, expect } from "vitest";
import { greetingFontSize, greetingName } from "./greetingName";

describe("greetingName", () => {
  it("keeps a two-word name whole — the design's own example", () => {
    expect(greetingName("Nurul Huda")).toBe("Nurul Huda");
  });

  it("takes two words from a long name, not one", () => {
    // One word would give "Ahmad", and for "Mohd ..." / "Siti ..." the first
    // word is a prefix rather than the name anyone is called by.
    expect(greetingName("Ahmad Faizal Bin Rahman")).toBe("Ahmad Faizal");
    expect(greetingName("Mohd Azmi Bin Abdullah")).toBe("Mohd Azmi");
  });

  it("survives a single word, empty, undefined and stray whitespace", () => {
    expect(greetingName("Aisyah")).toBe("Aisyah");
    expect(greetingName("")).toBe("");
    expect(greetingName(undefined)).toBe("");
    expect(greetingName("  Nurul   Huda  ")).toBe("Nurul Huda");
  });
});

describe("greetingFontSize", () => {
  it("leaves a short name at the design size", () => {
    expect(greetingFontSize("Nurul Huda", 24)).toBe(24);
  });

  it("steps down as the name grows", () => {
    expect(greetingFontSize("Ahmad Faizal Bin", 24)).toBe(21); // 16 chars
    expect(greetingFontSize("Ahmad Faizal Bin Rahman", 24)).toBe(19); // 23
    expect(greetingFontSize("Muhamad Zulkhairi Bin Yusuf Abdullah", 24)).toBe(17); // 36
  });

  it("never goes below the floor, however long the name", () => {
    // A 15px heading is already the smallest that still reads as one; past
    // that the callers' numberOfLines={2} takes over.
    expect(greetingFontSize("A".repeat(200), 20)).toBe(15);
    expect(greetingFontSize("A".repeat(200), 24)).toBe(17);
  });

  it("is monotonic — a longer name is never rendered LARGER", () => {
    let last = Infinity;
    for (const n of [2, 10, 14, 15, 22, 23, 30, 31, 80]) {
      const size = greetingFontSize("A".repeat(n), 24);
      expect(size).toBeLessThanOrEqual(last);
      last = size;
    }
  });
});
