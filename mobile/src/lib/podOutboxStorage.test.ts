import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getPodOutbox,
  enqueuePodItem,
  removePodItem,
  noteDirectPodUpload,
  flushPodOutbox,
} from "./podOutbox";

/**
 * THE STORAGE EDGE OF THE POD OUTBOX.
 *
 * podOutboxCore has 19 tests covering merge/replay/reconcile. This file — the
 * durable edge that actually holds a driver's undelivered work — had none, and
 * it is where the queue can be destroyed rather than merely mis-replayed.
 *
 * Every mutation is read-modify-write. While a failed read returned `[]`, the
 * next enqueue wrote a one-item array over a queue that might have held a day
 * of deliveries: silently, permanently, and reported to the driver as "saved
 * offline". Losing a delivery record is the worst outcome this system has, so
 * the read path now distinguishes "nothing stored" from "cannot be read", and
 * nothing writes on the second.
 */

const KEY = "uwc.podOutbox";
const mockStorage = AsyncStorage as unknown as {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};

/** A day's worth of queued work — the thing that must never be overwritten. */
const EXISTING = [
  { tripId: "t1", stopId: "s1", confirmDelivered: true, queuedAt: "2026-07-30T01:00:00.000Z" },
  { tripId: "t1", stopId: "s2", confirmDelivered: true, queuedAt: "2026-07-30T02:00:00.000Z" },
  { tripId: "t1", stopId: "s3", photo: "file://pod3.jpg", queuedAt: "2026-07-30T03:00:00.000Z" },
];

const writesTo = (key: string) => mockStorage.setItem.mock.calls.filter((c) => c[0] === key);

beforeEach(() => {
  vi.clearAllMocks();
  mockStorage.setItem.mockResolvedValue(undefined);
});

describe("POD outbox storage edge — a read failure must never destroy the queue", () => {
  it("enqueue THROWS and writes nothing when the queue cannot be read", async () => {
    mockStorage.getItem.mockRejectedValue(new Error("SQLITE_CORRUPT: database disk image is malformed"));

    await expect(
      enqueuePodItem({ tripId: "t1", stopId: "s4", confirmDelivered: true })
    ).rejects.toThrow();

    // The whole point: no write happened, so whatever is on disk survives.
    // Before this guard the call resolved and wrote a ONE-item array.
    expect(writesTo(KEY)).toHaveLength(0);
  });

  it("removePodItem and noteDirectPodUpload write nothing when the read fails", async () => {
    mockStorage.getItem.mockRejectedValue(new Error("storage unavailable"));

    // Best-effort cleanups: failing to remove costs one idempotent replay,
    // which the core already handles. Writing blind costs the queue.
    await expect(removePodItem("s1")).resolves.toBeUndefined();
    await expect(noteDirectPodUpload("s1")).resolves.toBeUndefined();
    expect(writesTo(KEY)).toHaveLength(0);
  });

  it("flush replays nothing and writes nothing when the read fails", async () => {
    mockStorage.getItem.mockRejectedValue(new Error("storage unavailable"));
    const api = {
      markArrived: vi.fn(),
      uploadPhoto: vi.fn(),
      ackK2: vi.fn(),
      confirmDelivered: vi.fn(),
    };

    const res = await flushPodOutbox(api as never);

    expect(res).toEqual({ outcomes: [], synced: 0, dropped: 0 });
    expect(api.confirmDelivered).not.toHaveBeenCalled();
    expect(writesTo(KEY)).toHaveLength(0);
  });

  it("the display path stays quiet on a read failure — it must not crash the screen", async () => {
    mockStorage.getItem.mockRejectedValue(new Error("storage unavailable"));
    // usePodOutbox does getPodOutbox().then(...) with no catch, so this one
    // resolves rather than throwing.
    await expect(getPodOutbox()).resolves.toEqual([]);
  });
});

describe("POD outbox storage edge — corrupt bytes are quarantined, not destroyed", () => {
  it("keeps unparseable bytes under their own key and starts clean", async () => {
    const corrupt = '[{"tripId":"t1","stopId":"s1",';
    mockStorage.getItem.mockResolvedValue(corrupt);

    await expect(getPodOutbox()).resolves.toEqual([]);

    const quarantined = mockStorage.setItem.mock.calls.filter((c) =>
      String(c[0]).startsWith("uwc.podOutbox.corrupt")
    );
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0][1]).toBe(corrupt); // recoverable, byte for byte
    expect(writesTo(KEY)).toHaveLength(0); // and the live key is untouched
  });

  it("treats a well-formed but NON-ARRAY value the same way", async () => {
    // e.g. a future migration writing an object, or another key colliding.
    mockStorage.getItem.mockResolvedValue('{"stopId":"s1"}');
    await expect(getPodOutbox()).resolves.toEqual([]);
    expect(
      mockStorage.setItem.mock.calls.filter((c) => String(c[0]).startsWith("uwc.podOutbox.corrupt"))
    ).toHaveLength(1);
  });

  it("a failed quarantine still lets the driver queue the delivery in front of them", async () => {
    mockStorage.getItem.mockResolvedValue("not json at all");
    mockStorage.setItem.mockImplementation((key: string) =>
      String(key).startsWith("uwc.podOutbox.corrupt")
        ? Promise.reject(new Error("quota exceeded"))
        : Promise.resolve(undefined)
    );

    await expect(
      enqueuePodItem({ tripId: "t1", stopId: "s9", confirmDelivered: true })
    ).resolves.toBeUndefined();

    const written = writesTo(KEY);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0][1] as string)).toHaveLength(1);
  });
});

describe("POD outbox storage edge — the normal paths still work", () => {
  it("enqueue merges into what is already stored rather than replacing it", async () => {
    mockStorage.getItem.mockResolvedValue(JSON.stringify(EXISTING));

    await enqueuePodItem({ tripId: "t1", stopId: "s4", confirmDelivered: true });

    const written = JSON.parse(writesTo(KEY)[0][1] as string);
    expect(written).toHaveLength(4);
    expect(written.map((i: { stopId: string }) => i.stopId)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("reads back exactly what is stored", async () => {
    mockStorage.getItem.mockResolvedValue(JSON.stringify(EXISTING));
    await expect(getPodOutbox()).resolves.toEqual(EXISTING);
  });

  it("an absent key is genuinely empty, not an error", async () => {
    mockStorage.getItem.mockResolvedValue(null);
    await expect(getPodOutbox()).resolves.toEqual([]);
    await expect(enqueuePodItem({ tripId: "t1", stopId: "s1", confirmDelivered: true })).resolves.toBeUndefined();
    expect(writesTo(KEY)).toHaveLength(1);
  });

  it("removePodItem drops only its own stop", async () => {
    mockStorage.getItem.mockResolvedValue(JSON.stringify(EXISTING));
    await removePodItem("s2");
    const written = JSON.parse(writesTo(KEY)[0][1] as string);
    expect(written.map((i: { stopId: string }) => i.stopId)).toEqual(["s1", "s3"]);
  });
});
