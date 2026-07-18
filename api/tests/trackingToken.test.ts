import { describe, it, expect } from "vitest";
import { signTrackingToken, verifyTrackingToken } from "../src/lib/trackingToken";

describe("trackingToken", () => {
  it("round-trips a trip id", () => {
    const id = "ckabc123def456";
    expect(verifyTrackingToken(signTrackingToken(id))).toBe(id);
  });

  it("rejects a tampered signature", () => {
    const tok = signTrackingToken("ckabc123def456");
    const tampered = tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A");
    expect(verifyTrackingToken(tampered)).toBeNull();
  });

  it("rejects a swapped trip id (signature no longer matches)", () => {
    const tok = signTrackingToken("trip-one");
    const sig = tok.slice(tok.lastIndexOf(".") + 1);
    expect(verifyTrackingToken(`trip-two.${sig}`)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyTrackingToken("")).toBeNull();
    expect(verifyTrackingToken("nodot")).toBeNull();
    expect(verifyTrackingToken(".onlysig")).toBeNull();
  });
});
