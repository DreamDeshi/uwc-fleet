import { describe, it, expect } from "vitest";
import { assertInterplantBooking } from "../src/services/interplant";
import { isInterplantRouteType, isUwcPlantName, UWC_PLANT_NAMES } from "../src/lib/uwcSpec";

/**
 * The interplant BOOKING constraint (A4 / workbook point 7). The pay rule itself
 * is in incentive.test.ts; this is only "who may a plant trip collect from and
 * deliver to".
 */

const plant = (n: number) => ({ company_name: `UWC Plant ${n}` });
const customer = { company_name: "KEYSIGHT BUILDING E (BAYAN LEPAS)" };
const ok = (over: Partial<Parameters<typeof assertInterplantBooking>[0]> = {}) =>
  assertInterplantBooking({
    routeTypeName: "Inter-Plant Delivery",
    pickupConsignee: plant(1),
    stopConsignees: [plant(4)],
    ...over,
  });

describe("interplant route types and plant names", () => {
  it("recognises both interplant route types and nothing else", () => {
    expect(isInterplantRouteType("Inter-Plant Delivery")).toBe(true);
    expect(isInterplantRouteType("Inter-Plant Return")).toBe(true);
    expect(isInterplantRouteType("Customer Delivery")).toBe(false);
    expect(isInterplantRouteType(null)).toBe(false);
    expect(isInterplantRouteType(undefined)).toBe(false);
  });

  it("knows exactly nine plants, 1 through 9", () => {
    expect(UWC_PLANT_NAMES).toHaveLength(9);
    expect(isUwcPlantName("UWC Plant 1")).toBe(true);
    expect(isUwcPlantName("UWC Plant 9")).toBe(true);
    expect(isUwcPlantName("UWC Plant 10")).toBe(false);
    // Substring and case traps — the name is an identity, not a prefix match.
    expect(isUwcPlantName("UWC Plant 1 (Annex)")).toBe(false);
    expect(isUwcPlantName("uwc plant 1")).toBe(false);
    expect(isUwcPlantName(null)).toBe(false);
  });
});

describe("assertInterplantBooking", () => {
  it("accepts a plant-to-plant booking", () => {
    expect(() => ok()).not.toThrow();
    expect(() => ok({ stopConsignees: [plant(2), plant(7)] })).not.toThrow();
    expect(() => ok({ routeTypeName: "Inter-Plant Return" })).not.toThrow();
  });

  it("requires a pickup point on an interplant booking", () => {
    expect(() => ok({ pickupConsignee: null })).toThrow(/PICKUP_POINT_REQUIRED|collected from/);
  });

  it("refuses a non-plant pickup", () => {
    expect(() => ok({ pickupConsignee: customer })).toThrow(/not one of them/);
  });

  it("refuses a non-plant delivery, naming the position", () => {
    expect(() => ok({ stopConsignees: [plant(2), customer] })).toThrow(/Stop 2 is not a UWC plant/);
    expect(() => ok({ stopConsignees: [customer, plant(2), customer] })).toThrow(
      /Stops 1, 3 are not a UWC plant/
    );
  });

  it("a CUSTOMER booking must not carry a pickup point", () => {
    // The other direction, and the one easiest to forget: without it a requestor
    // could set a pickup on an ordinary booking and either silently get the flat
    // interplant rate or silently get nothing.
    expect(() => ok({ routeTypeName: "Customer Delivery", pickupConsignee: plant(1) })).toThrow(
      /only be chosen for an Inter-Plant booking/
    );
  });

  it("a customer booking to a customer is untouched", () => {
    expect(() =>
      assertInterplantBooking({
        routeTypeName: "Customer Delivery",
        pickupConsignee: null,
        stopConsignees: [customer, customer],
      })
    ).not.toThrow();
  });

  it("a customer booking may deliver to a plant — only the ROUTE TYPE fences", () => {
    // Deliberate: the constraint is about what an INTERPLANT booking may do. A
    // customer run that happens to drop at a plant is not an interplant trip and
    // is not paid as one.
    expect(() =>
      assertInterplantBooking({
        routeTypeName: "Customer Delivery",
        pickupConsignee: null,
        stopConsignees: [plant(3)],
      })
    ).not.toThrow();
  });
});
