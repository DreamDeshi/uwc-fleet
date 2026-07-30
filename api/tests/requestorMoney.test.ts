import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { redactRequestorMoney, REQUESTOR_HIDDEN_MONEY_FIELDS } from "../src/lib/requestorMoney";

/**
 * Unit cover for the pure half of the requestor redaction.
 *
 * The behavioural proof lives in the integration tier (a real requestor token
 * against a real database), but that is the slower, DB-dependent job. This file
 * puts the function's EDGES in the fast gate — the one CI describes as "must
 * always be green" — because the edges are where a serialization filter does
 * damage: flatten a Decimal and every surviving amount on the response is
 * corrupted, for admins and drivers too.
 */
describe("redactRequestorMoney", () => {
  it("removes hidden fields at the top level and leaves the rest untouched", () => {
    const out = redactRequestorMoney({ id: "t1", status: "completed", incentive_earned: "44", rate_used: "11" });
    expect(out).toEqual({ id: "t1", status: "completed" });
  });

  it("reaches nested objects and arrays — the truck rate card and per-stop scoring", () => {
    const out = redactRequestorMoney({
      id: "t1",
      truck: { plate: "PND 1888", entitled_claim_weekday: "11", pending_claim_weekday: "99" },
      stops: [
        { id: "s1", zone_code: "A2", points_awarded: 6, was_repeat: false },
        { id: "s2", zone_code: "A2", points_awarded: 1, was_repeat: true },
      ],
    });
    expect(out).toEqual({
      id: "t1",
      truck: { plate: "PND 1888" },
      stops: [
        { id: "s1", zone_code: "A2" },
        { id: "s2", zone_code: "A2" },
      ],
    });
  });

  it("passes a Prisma Decimal through INTACT rather than recursing into it", () => {
    // The failure this prevents: walking a Decimal rebuilds it as a plain object,
    // so it serializes as {} and the amount is destroyed. A surviving amount must
    // still round-trip through JSON as its numeric string.
    const amount = new Prisma.Decimal("12.34");
    const out = redactRequestorMoney({ id: "t1", some_allowed_amount: amount, incentive_earned: "44" });
    expect(out.some_allowed_amount).toBeInstanceOf(Prisma.Decimal);
    expect(JSON.parse(JSON.stringify(out))).toEqual({ id: "t1", some_allowed_amount: "12.34" });
  });

  it("passes a Date through INTACT", () => {
    const when = new Date("2026-07-30T09:00:00.000Z");
    const out = redactRequestorMoney({ pickup_datetime: when, rate_used: "11" });
    expect(out.pickup_datetime).toBeInstanceOf(Date);
    expect(JSON.parse(JSON.stringify(out))).toEqual({ pickup_datetime: "2026-07-30T09:00:00.000Z" });
  });

  it("does not mutate its input — handlers may still hold the object", () => {
    const input = { id: "t1", incentive_earned: "44", truck: { entitled_claim_weekday: "11" } };
    const out = redactRequestorMoney(input);
    expect(input.incentive_earned).toBe("44");
    expect(input.truck.entitled_claim_weekday).toBe("11");
    expect(out).not.toBe(input);
  });

  it("handles a top-level array (the GET /trips list shape)", () => {
    const out = redactRequestorMoney([{ id: "a", rate_used: "11" }, { id: "b", rate_used: "13" }]);
    expect(out).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("walks null-prototype containers, and preserves null and primitives", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.zone_points = 6;
    bare.zone_code = "A2";
    const out = redactRequestorMoney({ nested: bare, missing: null, count: 0, flag: false, name: "" });
    expect(out).toEqual({ nested: { zone_code: "A2" }, missing: null, count: 0, flag: false, name: "" });
  });

  it("covers every name the redaction set claims to hide", () => {
    // Guards against a name being added to the set but the walk failing to reach
    // it — e.g. if the container check were ever narrowed.
    const payload = Object.fromEntries([...REQUESTOR_HIDDEN_MONEY_FIELDS].map((f) => [f, "x"]));
    expect(redactRequestorMoney({ ...payload, keep: "yes" })).toEqual({ keep: "yes" });
  });
});
