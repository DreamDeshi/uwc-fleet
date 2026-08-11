import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));

/**
 * podOutbox.ts now also reaches the filesystem, to move a queued POD photo out
 * of the OS-evictable cache directory (lib/podPhotoStore). Stubbed here for the
 * same reason AsyncStorage is: this file tests the QUEUE, and expo-file-system
 * cannot load under plain-node vitest. The real behaviour has its own suite in
 * podPhotoStore.test.ts; the spies below pin the WIRING, which nothing else does.
 */
const photoStore = vi.hoisted(() => ({
  persistPodPhoto: vi.fn((uri: string) => `file:///doc/pod-outbox/persisted-${uri.split("/").pop()}`),
  sweepPodPhotos: vi.fn(),
}));
vi.mock("./podPhotoStore", () => photoStore);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { setActiveUser } from "./scopedStorage";
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

// Storage is per-driver now (DG-D4): the module writes under the signed-in
// driver's namespace, so the test drives it as that driver.
const TEST_USER = "driver-test";
const KEY = `uwc.u.${TEST_USER}.podOutbox`;
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

beforeEach(async () => {
  vi.clearAllMocks();
  mockStorage.setItem.mockResolvedValue(undefined);
  await setActiveUser(TEST_USER);
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
      String(c[0]).startsWith(`uwc.u.${TEST_USER}.podOutbox.corrupt`)
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
      mockStorage.setItem.mock.calls.filter((c) => String(c[0]).startsWith(`uwc.u.${TEST_USER}.podOutbox.corrupt`))
    ).toHaveLength(1);
  });

  it("a failed quarantine still lets the driver queue the delivery in front of them", async () => {
    mockStorage.getItem.mockResolvedValue("not json at all");
    mockStorage.setItem.mockImplementation((key: string) =>
      String(key).startsWith(`uwc.u.${TEST_USER}.podOutbox.corrupt`)
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

/**
 * THE ERASE GUARD — "I read nothing" must never become "there is nothing".
 *
 * Three defects in one day shared that shape, so the refusal now lives BELOW
 * every writer instead of inside each one. These drive it through the public
 * API, using the one thing that can legitimately make a writer's view of the
 * queue stale: something else queueing between its read and its write.
 */
describe("POD outbox storage edge — an empty write must be accounted for", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  /** Read #1 is the caller's; read #2 is the guard's, after the world moved. */
  const readsThen = (first: unknown, second: unknown) => {
    let n = 0;
    mockStorage.getItem.mockImplementation((key: string) => {
      if (!String(key).endsWith(".podOutbox")) return Promise.resolve(null);
      n += 1;
      return Promise.resolve(JSON.stringify(n === 1 ? first : second));
    });
  };

  const ONLY = [EXISTING[0]];
  const RACED = [EXISTING[0], { tripId: "t1", stopId: "s9", confirmDelivered: true, queuedAt: "2026-07-30T09:00:00.000Z" }];

  it("refuses to empty the queue over an item the writer never saw", async () => {
    readsThen(ONLY, RACED);

    await removePodItem("s1");

    // s9 was queued after removePodItem read. Writing [] would have destroyed
    // a delivery the driver was told was saved.
    expect(writesTo(KEY)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("refusing to empty"));
    expect(warn.mock.calls.at(-1)?.[0]).toContain("s9");
  });

  it("refuses when the guard cannot see what it would be destroying", async () => {
    let n = 0;
    mockStorage.getItem.mockImplementation((key: string) => {
      if (!String(key).endsWith(".podOutbox")) return Promise.resolve(null);
      n += 1;
      return n === 1
        ? Promise.resolve(JSON.stringify(ONLY))
        : Promise.reject(new Error("SQLITE_CORRUPT: database disk image is malformed"));
    });

    await removePodItem("s1");

    expect(writesTo(KEY)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("storage unreadable"));
  });

  it("still performs the erase the writer CAN account for", async () => {
    // The guard must not become a reason the queue never empties: the same
    // race test above, minus the race.
    readsThen(ONLY, ONLY);

    await removePodItem("s1");

    expect(JSON.parse(writesTo(KEY)[0][1] as string)).toEqual([]);
  });

  it("noteDirectPodUpload's erase is guarded on the same terms", async () => {
    readsThen([{ ...EXISTING[0], confirmDelivered: false }], RACED);
    await noteDirectPodUpload("s1");
    expect(writesTo(KEY)).toHaveLength(0);
  });

  /**
   * ⚠ REACHABILITY, not behaviour. The tests above prove the guard WORKS; this
   * proves it is IN THE PROGRAM — that no path reaches the outbox key without
   * passing through the one writer that runs it. A second writer would leave
   * every test above green while re-opening the exact hole they cover.
   */
  it("writeOutbox is the only thing that writes the live outbox key", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "podOutbox.ts"), "utf-8");

    // One writer, and it is the guarded one.
    expect(src.match(/scopedSetItem\(OUTBOX_SUFFIX/g) ?? []).toHaveLength(1);
    // Any other scopedSetItem in this file must be the corrupt-quarantine key,
    // which by definition is not the live queue.
    const otherWrites = (src.match(/scopedSetItem\(\s*(?!OUTBOX_SUFFIX)([^)]*)/g) ?? []).filter(
      (m) => !m.includes("CORRUPT_SUFFIX_PREFIX")
    );
    expect(otherWrites).toEqual([]);
    // And nothing bypasses the scoped layer altogether (comments may NAME
    // AsyncStorage; only an import of it would let code reach past the guard).
    expect(src).not.toMatch(/from\s+["']@react-native-async-storage/);
  });
});

/**
 * ⚠ THE WIRING, not the filesystem behaviour (podPhotoStore.test.ts covers
 * that). Without these, the queue could go on storing the raw camera URI — the
 * cache path Android reclaims — and every test here would still pass, because
 * the queue itself would look perfectly correct.
 */
describe("queued photos are moved out of the evictable cache", () => {
  beforeEach(() => {
    mockStorage.getItem.mockResolvedValue(null);
  });

  it("stores the PERSISTED uri, not the camera's cache path", async () => {
    await enqueuePodItem({
      tripId: "t1",
      stopId: "s1",
      photo: { uri: "file:///cache/ImagePicker/abc.jpg", name: "pod.jpg", type: "image/jpeg" },
      confirmDelivered: true,
    });

    expect(photoStore.persistPodPhoto).toHaveBeenCalledWith(
      "file:///cache/ImagePicker/abc.jpg",
      "s1",
      expect.any(Number)
    );
    const written = JSON.parse(writesTo(KEY)[0][1] as string);
    expect(written[0].photo.uri).toBe("file:///doc/pod-outbox/persisted-abc.jpg");
    // The whole point: what lands in the queue is NOT the reclaimable path.
    expect(written[0].photo.uri).not.toContain("/cache/");
  });

  it("keeps the rest of the photo metadata intact", async () => {
    await enqueuePodItem({
      tripId: "t1",
      stopId: "s1",
      photo: { uri: "file:///cache/x.jpg", name: "pod.jpg", type: "image/jpeg" },
      confirmDelivered: true,
    });
    const written = JSON.parse(writesTo(KEY)[0][1] as string);
    expect(written[0].photo.name).toBe("pod.jpg");
    expect(written[0].photo.type).toBe("image/jpeg");
  });

  it("does not touch the filesystem for a photoless queue entry", async () => {
    await enqueuePodItem({ tripId: "t1", stopId: "s1", markArrived: true });
    expect(photoStore.persistPodPhoto).not.toHaveBeenCalled();
  });

  it("sweeps orphans after a write, passing the uris still referenced", async () => {
    await enqueuePodItem({
      tripId: "t1",
      stopId: "s1",
      photo: { uri: "file:///cache/x.jpg", name: "pod.jpg", type: "image/jpeg" },
      confirmDelivered: true,
    });
    expect(photoStore.sweepPodPhotos).toHaveBeenCalledWith(["file:///doc/pod-outbox/persisted-x.jpg"]);
  });

  it("sweeps with an empty list when the last item is removed", async () => {
    mockStorage.getItem.mockResolvedValue(
      JSON.stringify([{ tripId: "t1", stopId: "s1", confirmDelivered: true, queuedAt: "2026-08-03T00:00:00.000Z" }])
    );
    await removePodItem("s1");
    // Nothing referenced any more → every stored photo is collectable.
    expect(photoStore.sweepPodPhotos).toHaveBeenCalledWith([]);
  });
});
