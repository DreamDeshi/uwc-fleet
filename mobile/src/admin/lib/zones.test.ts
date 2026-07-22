import { describe, it, expect } from "vitest";
import { primaryZone } from "./zones";

describe("primaryZone", () => {
  it("takes the first RECOGNISED zone", () => {
    expect(primaryZone(["K1", "P1"])).toBe("K1");
    expect(primaryZone(["ZZ", "P3"])).toBe("P3"); // unknown code skipped
  });

  it("defaults to P2 when there are no usable zones", () => {
    expect(primaryZone([])).toBe("P2");
    expect(primaryZone(["ZZ"])).toBe("P2");
  });
});
