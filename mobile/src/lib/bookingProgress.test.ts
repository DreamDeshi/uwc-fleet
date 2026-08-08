import { describe, it, expect } from "vitest";
import {
  bookingActions,
  bookingStage,
  bookingStatusKey,
  isArrivedAtStop,
} from "./bookingProgress";
import type { TripStatus } from "../types";

const ALL: TripStatus[] = [
  "pending",
  "approved",
  "assigned",
  "in_progress",
  "pending_approval",
  "completed",
  "rejected",
  "cancelled",
];

const ctx = {
  hasDriverPhone: true,
  hasPod: true,
  changeRequestsEnabled: false,
};

describe("bookingStage — the four-tick progress bar (frame 9b)", () => {
  it("matches the design's stage per status", () => {
    expect(bookingStage("pending")).toBe(1);
    expect(bookingStage("approved")).toBe(1);
    expect(bookingStage("assigned")).toBe(2);
    expect(bookingStage("in_progress")).toBe(3);
    expect(bookingStage("completed")).toBe(4);
  });

  it("puts pending_approval at stage 4 — the design has no row, but the goods arrived", () => {
    // The outstanding step is an internal POD/pay approval the requestor has no
    // part in. Anything less than 4 would tell them their delivery is unfinished.
    expect(bookingStage("pending_approval")).toBe(4);
  });

  it("shows NO bar for a booking that never travelled", () => {
    expect(bookingStage("cancelled")).toBeNull();
    expect(bookingStage("rejected")).toBeNull();
  });
});

describe("isArrivedAtStop — the design's eighth row, derived not invented", () => {
  it("is true once a stop is reached but not yet delivered", () => {
    expect(
      isArrivedAtStop("in_progress", [{ status: "arrived", arrived_at: "2026-08-09T02:00:00Z" }])
    ).toBe(true);
  });

  it("is false before the truck reaches anything", () => {
    expect(isArrivedAtStop("in_progress", [{ status: "pending", arrived_at: null }])).toBe(false);
    expect(isArrivedAtStop("in_progress", [])).toBe(false);
  });

  it("does NOT label a finished trip 'Arrived'", () => {
    // Every delivered stop also carries an arrived_at, so testing arrival alone
    // would relabel every completed booking.
    const delivered = [{ status: "delivered", arrived_at: "2026-08-09T02:00:00Z" }];
    expect(isArrivedAtStop("completed", delivered)).toBe(false);
    expect(isArrivedAtStop("in_progress", delivered)).toBe(false);
  });

  it("is true mid-trip when one stop is done and the next is reached", () => {
    expect(
      isArrivedAtStop("in_progress", [
        { status: "delivered", arrived_at: "2026-08-09T01:00:00Z" },
        { status: "arrived", arrived_at: "2026-08-09T03:00:00Z" },
      ])
    ).toBe(true);
  });
});

describe("bookingStatusKey", () => {
  it("gives every status its own key", () => {
    for (const s of ALL) expect(bookingStatusKey(s)).toBe(`bookingDetail.state_${s}`);
  });

  it("overrides in_progress with Arrived once the truck is at a stop", () => {
    expect(
      bookingStatusKey("in_progress", [{ status: "arrived", arrived_at: "2026-08-09T02:00:00Z" }])
    ).toBe("bookingDetail.stateArrived");
  });
});

describe("bookingActions — the bottom bar per status", () => {
  it("gives every status at least one thing to do", () => {
    // A requestor who can see a booking but do nothing with it is the dead-end
    // pattern this bar exists to avoid.
    for (const s of ALL) expect(bookingActions(s, ctx).length).toBeGreaterThan(0);
  });

  it("offers Edit only while the booking is still pending", () => {
    expect(bookingActions("pending", ctx)).toContain("edit");
    for (const s of ALL.filter((x) => x !== "pending")) {
      expect(bookingActions(s, ctx)).not.toContain("edit");
    }
  });

  it("offers Cancel exactly while the server still allows it", () => {
    // The API permits cancel on pending/approved; assigned goes through the
    // dispatcher. Offering it anywhere else would be a button that 409s.
    const cancellable = ALL.filter((s) => bookingActions(s, ctx).includes("cancel"));
    expect(cancellable.sort()).toEqual(["approved", "assigned", "pending"]);
  });

  it("keeps Share Tracking on an assigned booking (frame 9b lists only Cancel)", () => {
    expect(bookingActions("assigned", ctx)).toContain("share");
  });

  it("shows Request Change only when the A19 flag is on", () => {
    expect(bookingActions("assigned", ctx)).not.toContain("requestChange");
    expect(bookingActions("assigned", { ...ctx, changeRequestsEnabled: true })).toContain(
      "requestChange"
    );
  });

  it("hides Call Driver when there is no number to dial", () => {
    expect(bookingActions("in_progress", ctx)).toContain("call");
    expect(bookingActions("in_progress", { ...ctx, hasDriverPhone: false })).not.toContain("call");
  });

  it("hides View POD when no photo exists, but still offers Rebook", () => {
    const noPod = bookingActions("completed", { ...ctx, hasPod: false });
    expect(noPod).not.toContain("viewPod");
    expect(noPod).toContain("rebook");
  });

  it("offers See Reason on a rejected booking", () => {
    // The design flags this as blocked on a data source; trip.rejection_reason
    // has existed since the POD-approval work.
    expect(bookingActions("rejected", ctx)).toEqual(["seeReason", "rebook"]);
  });

  it("lets a dead booking be rebooked", () => {
    expect(bookingActions("cancelled", ctx)).toEqual(["rebook"]);
  });
});
