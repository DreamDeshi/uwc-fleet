import { describe, it, expect } from "vitest";
import {
  availableDirections,
  availableFamilies,
  buildRouteMatrix,
  choiceForId,
  findRouteType,
  parseRouteTypeName,
  resolveDirection,
} from "./routeDirection";

// The six route types docs/uwc-spec.json seeds, in seed order.
const SEEDED = [
  { id: "cd", name: "Customer Delivery" },
  { id: "sd", name: "Supplier Delivery" },
  { id: "id", name: "Inter-Plant Delivery" },
  { id: "sr", name: "Supplier Return" },
  { id: "cr", name: "Customer Return" },
  { id: "ir", name: "Inter-Plant Return" },
];

describe("parseRouteTypeName", () => {
  it("decomposes every seeded route type", () => {
    expect(parseRouteTypeName("Customer Delivery")).toEqual({ family: "customer", direction: "delivery" });
    expect(parseRouteTypeName("Supplier Delivery")).toEqual({ family: "supplier", direction: "delivery" });
    expect(parseRouteTypeName("Inter-Plant Delivery")).toEqual({ family: "interplant", direction: "delivery" });
    expect(parseRouteTypeName("Supplier Return")).toEqual({ family: "supplier", direction: "return" });
    expect(parseRouteTypeName("Customer Return")).toEqual({ family: "customer", direction: "return" });
    expect(parseRouteTypeName("Inter-Plant Return")).toEqual({ family: "interplant", direction: "return" });
  });

  it("is loose about case and the inter-plant separator", () => {
    for (const name of ["inter plant return", "InterPlant Return", "INTER_PLANT RETURN"]) {
      expect(parseRouteTypeName(name)).toEqual({ family: "interplant", direction: "return" });
    }
  });

  it("refuses to guess a missing half rather than defaulting it", () => {
    // No direction word: guessing "delivery" would put a return trip on the
    // wrong lane, so this stays unmatched and renders as its own chip.
    expect(parseRouteTypeName("Customer")).toBeNull();
    expect(parseRouteTypeName("Ad-hoc Charter")).toBeNull();
    // A direction with an unknown family is equally unusable.
    expect(parseRouteTypeName("Warehouse Delivery")).toBeNull();
  });
});

describe("buildRouteMatrix", () => {
  it("maps the seeded six onto a 3 × 2 grid with nothing left over", () => {
    const matrix = buildRouteMatrix(SEEDED);
    expect(matrix.choices).toHaveLength(6);
    expect(matrix.unmatched).toEqual([]);
    expect(availableFamilies(matrix)).toEqual(["customer", "supplier", "interplant"]);
    expect(availableDirections(matrix, "customer")).toEqual(["delivery", "return"]);
    expect(findRouteType(matrix, "interplant", "return")?.id).toBe("ir");
  });

  it("KEEPS a route type it cannot decompose instead of hiding it", () => {
    // A hidden route type is a booking nobody can place, with no visible cause.
    const matrix = buildRouteMatrix([...SEEDED, { id: "x", name: "Ad-hoc Charter" }]);
    expect(matrix.choices).toHaveLength(6);
    expect(matrix.unmatched).toEqual([{ id: "x", name: "Ad-hoc Charter" }]);
  });

  it("reports only the families the server actually sent", () => {
    const matrix = buildRouteMatrix([{ id: "cd", name: "Customer Delivery" }]);
    expect(availableFamilies(matrix)).toEqual(["customer"]);
    expect(availableDirections(matrix, "customer")).toEqual(["delivery"]);
    expect(availableDirections(matrix, "supplier")).toEqual([]);
  });
});

describe("choiceForId — seeding the controls from a stored booking", () => {
  it("finds the family + direction behind a stored route_type_id", () => {
    const matrix = buildRouteMatrix(SEEDED);
    expect(choiceForId(matrix, "cr")).toMatchObject({ family: "customer", direction: "return" });
  });

  it("is undefined for an unknown or absent id", () => {
    const matrix = buildRouteMatrix(SEEDED);
    expect(choiceForId(matrix, "nope")).toBeUndefined();
    expect(choiceForId(matrix, undefined)).toBeUndefined();
  });
});

describe("resolveDirection — switching family must not strand the selection", () => {
  it("keeps the preferred direction when the new family offers it", () => {
    const matrix = buildRouteMatrix(SEEDED);
    expect(resolveDirection(matrix, "supplier", "return")).toBe("return");
  });

  it("falls back to the family's first direction when it does not", () => {
    // Server offers Customer both ways but Supplier one way only. Holding
    // "return" would leave the form with no route type and a Next that blocks.
    const matrix = buildRouteMatrix([
      { id: "cd", name: "Customer Delivery" },
      { id: "cr", name: "Customer Return" },
      { id: "sd", name: "Supplier Delivery" },
    ]);
    expect(resolveDirection(matrix, "supplier", "return")).toBe("delivery");
  });

  it("is undefined for a family with nothing behind it", () => {
    const matrix = buildRouteMatrix([{ id: "cd", name: "Customer Delivery" }]);
    expect(resolveDirection(matrix, "interplant", "delivery")).toBeUndefined();
  });
});
