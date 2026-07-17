import { describe, expect, it } from "vitest";
import { totalPallets, tripGroup } from "./trip";
import { tripStatusColor, tripStatusLabelKey } from "../theme";
import en from "../../i18n/en.json";
import ms from "../../i18n/ms.json";
import zh from "../../i18n/zh.json";
import type { Trip, TripStatus } from "../types";

const ALL_STATUSES: TripStatus[] = [
  "pending",
  "approved",
  "rejected",
  "assigned",
  "in_progress",
  "pending_approval",
  "completed",
  "cancelled",
];

/**
 * The pallet→4×4 conversion is duplicated across four files (api/src/lib/pallets,
 * mobile/src/lib/pallets, admin/src/lib/trip, and this one). Commit `802e032`
 * fixed the unknown-type guess in three of them and missed THIS one, so the two
 * admin surfaces disagreed about the same load — 1 slot on the phone, 0 on the
 * PC. These tests pin the shared contract on the copy that got left behind.
 *
 * Dispatch/capacity math is NOT affected by this file (api/src/lib/pallets.ts is
 * canonical and enforces the enum) — this is the admin's display total.
 */
const trip = (cargo: { pallet_type: string; quantity: number }[]) =>
  ({ cargo_details: cargo } as unknown as Trip);

describe("totalPallets — 4×4-equivalents (mirrors api/src/lib/pallets.ts)", () => {
  it("converts each bookable pallet size at its spec factor", () => {
    expect(totalPallets(trip([{ pallet_type: "2×2", quantity: 4 }]))).toBe(1);
    expect(totalPallets(trip([{ pallet_type: "3×4", quantity: 4 }]))).toBe(3);
    expect(totalPallets(trip([{ pallet_type: "4×4", quantity: 4 }]))).toBe(4);
    expect(totalPallets(trip([{ pallet_type: "4×8", quantity: 4 }]))).toBe(8);
    expect(totalPallets(trip([{ pallet_type: "5×10", quantity: 4 }]))).toBe(12.5);
  });

  it("gives cartons and custom/Others no pallet footprint", () => {
    expect(totalPallets(trip([{ pallet_type: "carton", quantity: 50 }]))).toBe(0);
    expect(totalPallets(trip([{ pallet_type: "custom", quantity: 1 }]))).toBe(0);
  });

  // The regression `802e032` left behind here: guessing one slot for an unknown
  // footprint is the UNSAFE direction (a 6×6 is ~2.25 slots, an ASCII "5x10" is
  // 3.125), and it made this surface disagree with admin/src/lib/trip.ts.
  it("gives an unrecognised footprint no slots rather than guessing one", () => {
    expect(totalPallets(trip([{ pallet_type: "6×6", quantity: 1 }]))).toBe(0);
    expect(totalPallets(trip([{ pallet_type: "5x10", quantity: 6 }]))).toBe(0); // ASCII x
  });

  it("keeps the 3.125 factor exact and free of float noise", () => {
    expect(totalPallets(trip([{ pallet_type: "5×10", quantity: 3 }]))).toBe(9.375);
  });

  it("sums mixed cargo lines", () => {
    expect(
      totalPallets(
        trip([
          { pallet_type: "4×4", quantity: 2 }, // 2
          { pallet_type: "5×10", quantity: 2 }, // 6.25
          { pallet_type: "carton", quantity: 30 }, // 0
        ])
      )
    ).toBe(8.25);
  });
});

describe("tripGroup — the dispatch board's four columns", () => {
  it("REGRESSION: a delivered trip awaiting POD approval is NOT filed as cancelled", () => {
    // The defect: `tripGroup(status: string)` ended in a bare
    // `return "cancelled"`, so item 9's new status was absorbed by the fallback
    // and the board showed successfully DELIVERED trips in the CANCELLED
    // column — on the screen an admin works from all day.
    expect(tripGroup("pending_approval")).not.toBe("cancelled");
    expect(tripGroup("pending_approval")).toBe("completed");
  });

  it("groups every status the way the board expects", () => {
    expect(tripGroup("pending")).toBe("pending");
    expect(tripGroup("approved")).toBe("active");
    expect(tripGroup("assigned")).toBe("active");
    expect(tripGroup("in_progress")).toBe("active");
    expect(tripGroup("pending_approval")).toBe("completed");
    expect(tripGroup("completed")).toBe("completed");
    expect(tripGroup("cancelled")).toBe("cancelled");
    expect(tripGroup("rejected")).toBe("cancelled");
  });

  it("only files genuine failures under cancelled", () => {
    const cancelled = ALL_STATUSES.filter((s) => tripGroup(s) === "cancelled");
    expect(cancelled.sort()).toEqual(["cancelled", "rejected"]);
  });
});

describe("admin status badge — colour and label exist for EVERY status", () => {
  // These two maps have no type relationship to TripStatus that TypeScript can
  // enforce end-to-end: tripStatusColor is now keyed on the union (so tsc
  // covers it), but the i18n JSON is just JSON — a missing key there compiles
  // fine and renders the raw enum. That is exactly what shipped: an admin saw
  // the literal text "PENDING_APPROVAL" on the board in all three languages.
  it.each(ALL_STATUSES)("tripStatusColor has an entry for %s", (status) => {
    expect(tripStatusColor[status]).toBeDefined();
  });

  const bundles: Array<[string, Record<string, unknown>]> = [
    ["en", en as Record<string, unknown>],
    ["ms", ms as Record<string, unknown>],
    ["zh", zh as Record<string, unknown>],
  ];

  it.each(bundles)("%s has an admin.status label for every status", (_lang, bundle) => {
    const labels = (bundle.admin as { status: Record<string, string> }).status;
    for (const status of ALL_STATUSES) {
      const key = tripStatusLabelKey(status).replace("admin.status.", "");
      expect(labels[key], `missing admin.status.${status}`).toBeTruthy();
      // A label that is just the enum echoed back is not a translation.
      expect(labels[key]).not.toBe(status);
    }
  });
});
