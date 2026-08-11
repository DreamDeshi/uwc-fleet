import { describe, expect, it } from "vitest";
import {
  flushOutboxItems,
  mergeOutboxItem,
  reconcileOutboxAfterFlush,
  MAX_API_FAILURES,
  OUTBOX_STALE_CODES,
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
    markArrived: false,
    arrivedMarked: false,
    photo: PHOTO,
    photoUploaded: false,
    photoCapturedAt: null,
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
  arrivedFails?: unknown;
  uploadFails?: unknown;
  ackFails?: unknown;
  confirmFails?: unknown;
}): PodOutboxApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async markArrived() {
      calls.push("arrived");
      if (opts.arrivedFails) throw opts.arrivedFails;
    },
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
  it("runs arrived → photo → K2 ack → delivered in order and dequeues on success", async () => {
    const api = fakeApi({});
    const res = await flushOutboxItems([item({ markArrived: true, k2FormAck: true })], api);
    expect(api.calls).toEqual(["arrived", "upload", "ack", "confirm"]);
    expect(res.synced).toBe(1);
    expect(res.outcomes[0].outcome).toBe("synced");
  });

  it("an arrived retry that hits 'already marked arrived' (INVALID_STATUS) continues to the next step", async () => {
    const api = fakeApi({ arrivedFails: apiErr("INVALID_STATUS") });
    const res = await flushOutboxItems([item({ markArrived: true })], api);
    expect(api.calls).toEqual(["arrived", "upload", "confirm"]);
    expect(res.synced).toBe(1);
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

  it("a photo replay after the trip FINALIZED (POD_LOCKED) counts as done, not a failure", async () => {
    // The trip completed before this queued retake flushed. The server locks POD
    // at finalization → POD_LOCKED; the finalized trip already holds its POD, so
    // the photo step is "already recorded": commit it and finish the item.
    const api = fakeApi({ uploadFails: apiErr("POD_LOCKED") });
    const res = await flushOutboxItems([item({ confirmDelivered: false })], api);
    expect(api.calls).toEqual(["upload"]); // tried once, no retry loop
    expect(res.outcomes[0].outcome).toBe("synced"); // NOT kept/dropped
    expect(res.outcomes[0].item.photoUploaded).toBe(true);
    expect(res.outcomes[0].item.apiFailures).toBe(0); // never counted as a failure
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

  // ── DG-D5: the logout flush must not spend the retry budget ──────────────
  //
  // Drivers share handsets and log out several times a day. If each failed
  // logout flush counted, a couple of days of handovers on a bad connection
  // would exhaust all five and DELETE the POD — the exact outcome the
  // flush-then-confirm decision exists to prevent, immediately after a dialog
  // that said "log out anyway?".
  it("survives MAX_API_FAILURES logout flushes without losing the item or the budget", async () => {
    let current = item({ photo: null });

    for (let attempt = 1; attempt <= MAX_API_FAILURES; attempt++) {
      const api = fakeApi({ confirmFails: apiErr("INTERNAL") });
      const res = await flushOutboxItems([current], api, { consumeFailureBudget: false });
      current = res.outcomes[0].item;

      expect(res.outcomes[0].outcome).toBe("kept");
      expect(res.dropped).toBe(0);
      // The counter never moves, so the NEXT driver-initiated flush still has
      // the whole budget — logout neither deletes the item nor erodes it.
      expect(current.apiFailures).toBe(0);
    }

    // One more, this time a real driver-initiated flush: the budget is intact,
    // so this is failure #1 of 5 and the item is still kept.
    const after = await flushOutboxItems([current], fakeApi({ confirmFails: apiErr("INTERNAL") }));
    expect(after.outcomes[0].outcome).toBe("kept");
    expect(after.outcomes[0].item.apiFailures).toBe(1);
  });

  it("still drops a STALE item on a logout flush — that is not a failure", async () => {
    // Not spending the budget must not become "logout can never resolve
    // anything". A stale code means the server already has this work; keeping
    // it would replay a delivery that is already recorded.
    const api = fakeApi({ confirmFails: apiErr(OUTBOX_STALE_CODES[0]) });
    const res = await flushOutboxItems([item({ photo: null })], api, {
      consumeFailureBudget: false,
    });
    expect(res.outcomes[0].outcome).toBe("dropped");
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

describe("photoCapturedAt — when the POD was TAKEN, not when it replayed", () => {
  // The server's pod_uploaded_at is its own receipt, which for a queued POD is
  // the replay instant — hours late for the rural driver the outbox exists for.
  // usePodOutbox sends this as `captured_client_at` so the pair can show both.

  it("is stamped when a photo is queued", () => {
    const items = mergeOutboxItem([], { tripId: "t1", stopId: "s1", photo: PHOTO }, "16:45");
    expect(items[0].photoCapturedAt).toBe("16:45");
  });

  it("prefers an explicit capture time over the merge instant", () => {
    // The screen stamps it when the CAMERA returns; queueing happens later, on
    // the network failure, so the two are not the same moment.
    const items = mergeOutboxItem(
      [],
      { tripId: "t1", stopId: "s1", photo: PHOTO, photoCapturedAt: "16:45" },
      "16:52"
    );
    expect(items[0].photoCapturedAt).toBe("16:45");
  });

  it("is NOT queuedAt — a later photo re-times capture while queuedAt stands", () => {
    // The bug this exists to avoid: tap Arrived offline at 15:00, photograph at
    // 16:45. queuedAt survives a retake by design, so sending it would report
    // the Arrived tap as the POD time.
    let items = mergeOutboxItem([], { tripId: "t1", stopId: "s1", markArrived: true }, "15:00");
    expect(items[0].photoCapturedAt).toBeNull();

    items = mergeOutboxItem(items, { tripId: "t1", stopId: "s1", photo: PHOTO }, "16:45");
    expect(items[0].queuedAt).toBe("15:00"); // unchanged, as before
    expect(items[0].photoCapturedAt).toBe("16:45"); // the actual capture
  });

  it("a RETAKE re-times it, like photoUploaded resets", () => {
    let items = mergeOutboxItem([], { tripId: "t1", stopId: "s1", photo: PHOTO }, "16:45");
    items = mergeOutboxItem(items, { tripId: "t1", stopId: "s1", photo: PHOTO }, "17:10");
    expect(items[0].photoCapturedAt).toBe("17:10");
    expect(items[0].photoUploaded).toBe(false);
  });

  it("a non-photo intent leaves it alone", () => {
    let items = mergeOutboxItem([], { tripId: "t1", stopId: "s1", photo: PHOTO }, "16:45");
    items = mergeOutboxItem(items, { tripId: "t1", stopId: "s1", confirmDelivered: true }, "17:00");
    expect(items[0].photoCapturedAt).toBe("16:45");
  });
});
