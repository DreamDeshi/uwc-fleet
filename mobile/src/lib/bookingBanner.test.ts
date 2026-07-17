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
