import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));

/**
 * services/api pulls in axios, i18n and expo config, none of which load under
 * plain-node vitest. Only three things matter to this file: the POST, and the
 * two error classifiers whose REAL implementations live in services/api.ts
 * (isNetworkError = "no response"; apiErrorCode = the API's error code).
 */
const apiMock = vi.hoisted(() => ({
  api: { post: vi.fn() },
  apiErrorCode: (err: unknown) => (err as { code?: string })?.code ?? null,
  isNetworkError: (err: unknown) => (err as { network?: boolean })?.network === true,
  loadStoredTokens: vi.fn(),
}));
vi.mock("../services/api", () => apiMock);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { flushQueuedLocations } from "./locationFlush";

const QUEUE_KEY = "uwc.locationQueue";

const point = (trip_id: string, n: number) => ({
  trip_id,
  latitude: 5.34,
  longitude: 100.46,
  recorded_at: new Date(Date.UTC(2026, 7, 10, 1, n)).toISOString(),
});

/** The AsyncStorage-backed queue, as a plain in-memory array. */
let stored: ReturnType<typeof point>[] = [];
const setQueue = (points: ReturnType<typeof point>[]) => {
  stored = [...points];
};

beforeEach(() => {
  vi.clearAllMocks();
  stored = [];
  (AsyncStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) =>
    k === QUEUE_KEY ? JSON.stringify(stored) : null
  );
  (AsyncStorage.setItem as ReturnType<typeof vi.fn>).mockImplementation(
    async (k: string, v: string) => {
      if (k === QUEUE_KEY) stored = JSON.parse(v);
    }
  );
});

const netErr = () => Object.assign(new Error("Network Error"), { network: true });
const apiErr = (code: string) => Object.assign(new Error(code), { code });

/**
 * THE POISON-BATCH WEDGE (10 Aug 2026).
 *
 * A driver's phone sat at "Offline · 500 queued" on a full 5G signal. The queue
 * is ONE global buffer across every trip, the flush POSTed all of it in a single
 * request, and the server 404s the WHOLE batch if any one trip_id is unknown.
 * The catch put the queue back untouched, so the next flush sent the identical
 * payload — forever, while the 500-point cap discarded a reading every 30s.
 *
 * Every test below fails against that single-batch implementation.
 */
describe("flushQueuedLocations — one bad trip cannot strand the rest", () => {
  it("uploads the healthy trip and DROPS the deleted one, draining the queue", async () => {
    setQueue([point("live-trip", 1), point("dead-trip", 2), point("live-trip", 3)]);

    apiMock.api.post.mockImplementation(async (_url: string, body: { points: { trip_id: string }[] }) => {
      if (body.points.some((p) => p.trip_id === "dead-trip")) throw apiErr("TRIP_NOT_FOUND");
      return { data: { accepted: body.points.length, inactive_trip_ids: [] } };
    });

    const res = await flushQueuedLocations();

    // The whole point: the queue actually empties. Under the old code this was
    // 3 — nothing moved, and it would never move again.
    expect(res.count).toBe(0);
    expect(res.dropped).toBe(1);
    expect(stored).toEqual([]);
    // One POST per trip, not one for everything.
    expect(apiMock.api.post).toHaveBeenCalledTimes(2);
  });

  it("drops a trip reassigned to another driver (403) rather than retrying it forever", async () => {
    setQueue([point("someone-elses-trip", 1)]);
    apiMock.api.post.mockRejectedValue(apiErr("FORBIDDEN"));

    const res = await flushQueuedLocations();

    expect(res.dropped).toBe(1);
    expect(res.count).toBe(0);
  });

  it("KEEPS everything when there is no signal", async () => {
    setQueue([point("live-trip", 1), point("live-trip", 2)]);
    apiMock.api.post.mockRejectedValue(netErr());

    const res = await flushQueuedLocations();

    expect(res.dropped).toBe(0);
    expect(res.count).toBe(2);
    expect(stored).toHaveLength(2);
  });

  it("KEEPS points on a server error — a 500 is transient, not a reason to bin GPS", async () => {
    setQueue([point("live-trip", 1)]);
    apiMock.api.post.mockRejectedValue(apiErr("INTERNAL"));

    const res = await flushQueuedLocations();

    expect(res.dropped).toBe(0);
    expect(res.count).toBe(1);
  });

  it("still reports inactive trip ids, so the background task can self-stop", async () => {
    setQueue([point("ended-trip", 1)]);
    apiMock.api.post.mockResolvedValue({
      data: { accepted: 1, inactive_trip_ids: ["ended-trip"] },
    });

    const res = await flushQueuedLocations();

    expect(res.inactiveTripIds).toEqual(["ended-trip"]);
    expect(res.count).toBe(0);
  });

  it("does nothing and posts nothing on an empty queue", async () => {
    setQueue([]);
    const res = await flushQueuedLocations();
    expect(res).toEqual({ count: 0, inactiveTripIds: [], dropped: 0 });
    expect(apiMock.api.post).not.toHaveBeenCalled();
  });
});
