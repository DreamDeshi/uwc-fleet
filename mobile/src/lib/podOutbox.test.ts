import { describe, expect, it } from "vitest";
import {
  flushOutboxItems,
  mergeOutboxItem,
  reconcileOutboxAfterFlush,
  MAX_API_FAILURES,
  type ItemOutcome,
  type PodOutboxApi,
  type PodOutboxItem,
} from "./podOutboxCore";

// Deliberately imports podOutboxCore (pure, no react-native/AsyncStorage) so
// the replay logic runs under plain-node vitest; the storage edge in
// podOutbox.ts stays untested, same as locationQueue.

const PHOTO = { uri: "file:///pod.jpg", name: "pod.jpg", type: "image/jpeg" };

function item(overrides: Partial<PodOutboxItem> = {}): PodOutboxItem {
  return {
    tripId: "t1",
    stopId: "s1",
    photo: PHOTO,
    photoUploaded: false,
    k2FormAck: false,
    k2Acked: false,
    confirmDelivered: true,
    queuedAt: "2026-07-05T10:00:00.000Z",
    apiFailures: 0,
    ...overrides,
  };
}

// A fake API that records calls and fails per-step on command.
function fakeApi(opts: {
  uploadFails?: unknown;
  ackFails?: unknown;
  confirmFails?: unknown;
}): PodOutboxApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async uploadPod() {
      calls.push("upload");
      if (opts.uploadFails) throw opts.uploadFails;
    },
    async ackK2() {
      calls.push("ack");
      if (opts.ackFails) throw opts.ackFails;
    },
    async confirmDelivered() {
      calls.push("confirm");
      if (opts.confirmFails) throw opts.confirmFails;
    },
    errorCode: (err) => (err as { code?: string })?.code ?? null,
    isNetworkError: (err) => (err as { network?: boolean })?.network === true,
  };
}

const NETWORK_ERR = { network: true };
const apiErr = (code: string) => ({ code });

describe("mergeOutboxItem — one item per stop, intents merge", () => {
  it("creates a fresh item for a stop", () => {
    const items = mergeOutboxItem([], { tripId: "t1", stopId: "s1", photo: PHOTO }, "now");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ photo: PHOTO, confirmDelivered: false, queuedAt: "now" });
  });

  it("a later Delivered tap merges into the queued photo item without losing it", () => {
    let items = mergeOutboxItem([], { tripId: "t1", stopId: "s1", photo: PHOTO }, "now");
    items = mergeOutboxItem(items, { tripId: "t1", stopId: "s1", confirmDelivered: true }, "later");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ photo: PHOTO, confirmDelivered: true, queuedAt: "now" });
  });

  it("a retake replaces the queued photo and resets its uploaded flag", () => {
    const uploaded = [item({ photo: null, photoUploaded: true })];
    const items = mergeOutboxItem(
      uploaded,
      { tripId: "t1", stopId: "s1", photo: { ...PHOTO, uri: "file:///retake.jpg" } },
      "now"
    );
    expect(items[0].photo?.uri).toBe("file:///retake.jpg");
    expect(items[0].photoUploaded).toBe(false);
    expect(items[0].confirmDelivered).toBe(true); // intent survives the retake
  });
});

describe("flushOutboxItems — replay when connectivity returns", () => {
  it("runs photo → K2 ack → delivered in order and dequeues on success", async () => {
    const api = fakeApi({});
    const res = await flushOutboxItems([item({ k2FormAck: true })], api);
    expect(api.calls).toEqual(["upload", "ack", "confirm"]);
    expect(res.synced).toBe(1);
    expect(res.outcomes[0].outcome).toBe("synced");
  });

  it("keeps the item when the network is still down (enqueue survives)", async () => {
    const api = fakeApi({ uploadFails: NETWORK_ERR });
    const res = await flushOutboxItems([item()], api);
    expect(res.outcomes[0].outcome).toBe("kept");
    expect(res.outcomes[0].item.photoUploaded).toBe(false);
    expect(res.synced).toBe(0);
  });

  it("treats 'already recorded' replies as SUCCESS and dequeues without error", async () => {
    for (const code of ["STOP_ALREADY_DELIVERED", "TRIP_ALREADY_FINALIZED", "TRIP_NOT_ACTIVE"]) {
      const api = fakeApi({ confirmFails: apiErr(code) });
      const res = await flushOutboxItems([item({ photo: null })], api);
      expect(res.outcomes[0].outcome).toBe("synced");
    }
  });

  it("IDEMPOTENCY: a retry after a partial success never repeats the photo upload", async () => {
    // First flush: photo commits, the delivered confirm dies on the network.
    const first = fakeApi({ confirmFails: NETWORK_ERR });
    const r1 = await flushOutboxItems([item()], first);
    expect(first.calls).toEqual(["upload", "confirm"]);
    const kept = r1.outcomes[0].item;
    expect(r1.outcomes[0].outcome).toBe("kept");
    expect(kept.photoUploaded).toBe(true); // progress persisted on the item
    expect(kept.photo).toBeNull(); // queued image freed once committed

    // Reconnect: the retry must NOT upload again — confirm only.
    const second = fakeApi({});
    const r2 = await flushOutboxItems([kept], second);
    expect(second.calls).toEqual(["confirm"]);
    expect(r2.synced).toBe(1);
  });

  it("a photo-only item (driver never tapped Delivered) uploads and dequeues without confirming", async () => {
    const api = fakeApi({});
    const res = await flushOutboxItems([item({ confirmDelivered: false })], api);
    expect(api.calls).toEqual(["upload"]);
    expect(res.synced).toBe(1);
  });

  it("drops stale items the driver can never complete (reassigned / deleted trip)", async () => {
    const api = fakeApi({ confirmFails: apiErr("FORBIDDEN") });
    const res = await flushOutboxItems([item({ photo: null })], api);
    expect(res.outcomes[0].outcome).toBe("dropped");
    expect(res.dropped).toBe(1);
  });

  it("gives up after MAX_API_FAILURES persistent non-network errors, not before", async () => {
    let current = item({ photo: null });
    for (let attempt = 1; attempt <= MAX_API_FAILURES; attempt++) {
      const api = fakeApi({ confirmFails: apiErr("INTERNAL") });
      const res = await flushOutboxItems([current], api);
      current = res.outcomes[0].item;
      expect(res.outcomes[0].outcome).toBe(attempt < MAX_API_FAILURES ? "kept" : "dropped");
    }
  });
});

describe("reconcileOutboxAfterFlush — folding results into a live queue", () => {
  it("removes synced items and persists kept items' progress", () => {
    const kept = item({ stopId: "s2", photoUploaded: true, photo: null });
    const outcomes: ItemOutcome[] = [
      { item: item({ stopId: "s1" }), outcome: "synced" },
      { item: kept, outcome: "kept" },
    ];
    const stored = [item({ stopId: "s1" }), item({ stopId: "s2" })];
    const next = reconcileOutboxAfterFlush(stored, outcomes);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ stopId: "s2", photoUploaded: true });
  });

  it("an item RE-QUEUED during the flush survives a synced outcome for its old version", () => {
    // Flush processed the 10:00 version; meanwhile the driver retook the photo
    // at 10:05 (new queuedAt) — the new intent must not be dequeued.
    const outcomes: ItemOutcome[] = [
      { item: item({ queuedAt: "10:00" }), outcome: "synced" },
    ];
    const stored = [item({ queuedAt: "10:05" })];
    expect(reconcileOutboxAfterFlush(stored, outcomes)).toEqual(stored);
  });
});
