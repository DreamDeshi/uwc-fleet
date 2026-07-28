import { describe, it, expect } from "vitest";
import { bannerFor } from "./bookingBanner";
import { colors } from "../theme";
import type { TripStatus } from "../types";

describe("bannerFor — pending_approval (the item 9 regression)", () => {
  it("shows DELIVERED, not cancelled, for a booking awaiting POD approval", () => {
    const banner = bannerFor("pending_approval");

    // The defect: `pending_approval` fell to a `default:` branch and rendered
    // the red "Booking Cancelled" banner on a successfully delivered booking.
    expect(banner.textKey).not.toBe("bookingDetail.bannerCancelled");
    expect(banner.bg).not.toBe(colors.red);

    // What it must show instead — the goods arrived.
    expect(banner.textKey).toBe("bookingDetail.bannerCompleted");
    expect(banner.bg).toBe(colors.green);
    expect(banner.icon).toBe("checkmark-done");
  });

  it("is indistinguishable from completed — the pay gate is invisible to the requestor", () => {
    // Deliberate: the approval step is between the driver and an admin. A
    // requestor cannot act on it, so it must not leak into their UI.
    expect(bannerFor("pending_approval")).toEqual(bannerFor("completed"));
  });
});

describe("bannerFor — every status renders a sane banner", () => {
  const cases: Array<[TripStatus, string]> = [
    ["pending", "bookingDetail.bannerPending"],
    ["approved", "bookingDetail.bannerPending"],
    ["assigned", "bookingDetail.bannerAccepted"],
    ["in_progress", "bookingDetail.bannerInProgress"],
    ["pending_approval", "bookingDetail.bannerCompleted"],
    ["completed", "bookingDetail.bannerCompleted"],
    ["rejected", "bookingDetail.bannerRejected"],
    ["cancelled", "bookingDetail.bannerCancelled"],
  ];

  it.each(cases)("%s → %s", (status, textKey) => {
    expect(bannerFor(status).textKey).toBe(textKey);
  });

  it("only ever paints red for genuinely bad outcomes", () => {
    // The regression class: a non-terminal status wearing the alarm colour.
    const red: TripStatus[] = [];
    for (const [status] of cases) {
      if (bannerFor(status).bg === colors.red) red.push(status);
    }
    expect(red.sort()).toEqual(["cancelled", "rejected"]);
  });
});

describe("bannerFor — partially delivered (28 Jul partial-pay-on-abort)", () => {
  // A partial abort ends pending_approval → completed with undelivered stops;
  // status alone would say "Delivered" for stops that never happened, and the
  // requestor would have no idea to re-book them (H1).
  it.each(["pending_approval", "completed"] as const)(
    "%s + undelivered stops → the partial banner, not green Delivered",
    (status) => {
      const banner = bannerFor(status, { partiallyDelivered: true });
      expect(banner.textKey).toBe("bookingDetail.bannerPartiallyDelivered");
      // Yellow: not red (goods did move), not green (the booking is not done).
      expect(banner.bg).toBe(colors.yellow);
      expect(banner.icon).toBe("alert-circle");
    }
  );

  it("a fully delivered trip keeps the green Delivered banner", () => {
    expect(bannerFor("completed", { partiallyDelivered: false })).toEqual(bannerFor("completed"));
  });

  it("the flag is ignored outside the delivered family — in transit stays blue", () => {
    // Every in_progress trip trivially has undelivered stops; the partial
    // notice must never fire before the trip has ended.
    expect(bannerFor("in_progress", { partiallyDelivered: true })).toEqual(bannerFor("in_progress"));
    expect(bannerFor("cancelled", { partiallyDelivered: true })).toEqual(bannerFor("cancelled"));
  });
});
