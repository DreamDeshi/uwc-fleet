import { describe, expect, it } from "vitest";
import { consigneesNotFoundError } from "../src/routes/trips";

// DG-R9: the CONSIGNEE_NOT_FOUND message must NAME the failing stop
// position(s) — both booking paths used to throw a generic string that left a
// multi-stop requestor guessing which stop broke.

const stops = [{ consignee_id: "a" }, { consignee_id: "b" }, { consignee_id: "c" }];

describe("consigneesNotFoundError", () => {
  it("names a single failing stop by its 1-based position", () => {
    const err = consigneesNotFoundError(stops, [{ id: "a" }, { id: "c" }]);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("CONSIGNEE_NOT_FOUND");
    expect(err.message).toContain("stop 2");
    expect(err.message).not.toContain("stops");
  });

  it("lists every failing position when several stops break", () => {
    const err = consigneesNotFoundError(stops, [{ id: "b" }]);
    expect(err.message).toContain("stops 1, 3");
  });

  it("keeps the error code stable for existing client handling", () => {
    const err = consigneesNotFoundError(stops, []);
    expect(err.code).toBe("CONSIGNEE_NOT_FOUND");
    expect(err.message).toContain("stops 1, 2, 3");
  });
});
