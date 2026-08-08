import { describe, it, expect } from "vitest";
import { homeAttention, isTracked, trackedCount, untrackedTrucks } from "./adminHome";
import type { DashboardKpis, LivePosition, Truck } from "../types";

const truck = (plate: string, status: Truck["status"]): Truck =>
  ({ plate, status }) as unknown as Truck;
const pos = (plate: string): LivePosition => ({ plate }) as unknown as LivePosition;

const kpis = (over: Partial<DashboardKpis> = {}): DashboardKpis =>
  ({ auto_dispatch_failed: 0, awaiting_manual: 0, ...over }) as unknown as DashboardKpis;

describe("isTracked / trackedCount", () => {
  it("a truck is on the map only when the live feed has its plate", () => {
    const live = [pos("BQP 3392")];
    expect(isTracked(truck("BQP 3392", "active"), live)).toBe(true);
    expect(isTracked(truck("NDX 1190", "active"), live)).toBe(false);
  });

  it("counts only non-retired trucks with a fix", () => {
    const trucks = [truck("A", "active"), truck("B", "active"), truck("C", "retired")];
    expect(trackedCount(trucks, [pos("A"), pos("C")])).toBe(1);
  });
});

describe("untrackedTrucks — what the map cannot show, and why", () => {
  it("lists every non-retired truck without a fix", () => {
    const trucks = [
      truck("BQP 3392", "active"),
      truck("NDX 1190", "maintenance"),
      truck("WWH 8821", "idle"),
    ];
    const out = untrackedTrucks(trucks, [pos("BQP 3392")]);
    expect(out.map((tr) => tr.plate)).toEqual(["NDX 1190", "WWH 8821"]);
  });

  it("ranks maintenance above idle above a silent ACTIVE truck", () => {
    // An active truck with no fix is the interesting one — it usually means the
    // driver's phone is off — but it is rarer, so it sorts last of the three
    // rather than burying the two that are simply parked.
    const trucks = [truck("C", "active"), truck("B", "idle"), truck("A", "maintenance")];
    expect(untrackedTrucks(trucks, []).map((tr) => tr.status)).toEqual([
      "maintenance",
      "idle",
      "active",
    ]);
  });

  it("never lists a retired truck — it is not fleet any more", () => {
    expect(untrackedTrucks([truck("OLD", "retired")], [])).toEqual([]);
  });

  it("is stable within a status band, by plate", () => {
    const trucks = [truck("ZZZ 1", "idle"), truck("AAA 1", "idle")];
    expect(untrackedTrucks(trucks, []).map((tr) => tr.plate)).toEqual(["AAA 1", "ZZZ 1"]);
  });

  it("is empty when everything is tracked", () => {
    expect(untrackedTrucks([truck("A", "active")], [pos("A")])).toEqual([]);
  });
});

describe("homeAttention — one line, the most blocked thing", () => {
  it("prefers a failed auto-dispatch over a queue awaiting manual", () => {
    // A booking the engine could not place has no truck reserved and nobody
    // driving it; one merely awaiting manual dispatch is a normal queue.
    const a = homeAttention(kpis({ auto_dispatch_failed: 1, awaiting_manual: 4 }));
    expect(a).toEqual({ key: "admin.home.stripDispatchFailed", count: 1 });
  });

  it("falls back to the manual queue", () => {
    expect(homeAttention(kpis({ awaiting_manual: 3 }))).toEqual({
      key: "admin.home.stripAwaitingManual",
      count: 3,
    });
  });

  it("says nothing when the fleet is quiet", () => {
    // A strip that always shows something becomes wallpaper.
    expect(homeAttention(kpis())).toBeNull();
    expect(homeAttention(undefined)).toBeNull();
  });
});
