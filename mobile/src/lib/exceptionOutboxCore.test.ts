import { describe, expect, it } from "vitest";
import {
  mergeOutboxItem,
  flushOutboxItems,
  reconcileOutboxAfterFlush,
  MAX_API_FAILURES,
  MAX_OUTBOX,
  type ExceptionOutboxApi,
  type ExceptionOutboxItem,
  type OutboxPatch,
} from "./exceptionOutboxCore";

// Pure core (no react-native / AsyncStorage), so the offline-replay logic runs
// under plain-node vitest — mirrors podOutboxCore.test.ts.

const photo = { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" };

function patch(over: Partial<OutboxPatch> = {}): OutboxPatch {
  return {
    tripId: "t1",
    clientOccurrenceId: "occ-1",
    clientActionId: "act-1",
    clientEvidenceId: "ev-1",
    category: "customer_site",
    reason: "gate locked",
    photo,
    lat: 5.28,
    lng: 100.46,
    accuracyM: 12,
    clientAt: "2026-08-01T02:00:00.000Z",
    ...over,
  };
}

function item(over: Partial<ExceptionOutboxItem> = {}): ExceptionOutboxItem {
  return {
    tripId: "t1",
    clientOccurrenceId: "occ-1",
    clientActionId: "act-1",
    clientEvidenceId: "ev-1",
    category: "customer_site",
    reason: "gate locked",
    tripStopId: null,
    photo,
    lat: 5.28,
    lng: 100.46,
    accuracyM: 12,
    clientAt: "2026-08-01T02:00:00.000Z",
    queuedAt: "2026-08-01T02:00:01.000Z",
    apiFailures: 0,
    ...over,
  };
}

class FakeApi implements ExceptionOutboxApi {
  constructor(private behavior: (item: ExceptionOutboxItem) => void = () => {}) {}
  calls = 0;
  async report(it: ExceptionOutboxItem) {
    this.calls++;
    this.behavior(it);
  }
  errorCode(err: unknown) {
    return (err as { code?: string })?.code ?? null;
  }
  isNetworkError(err: unknown) {
    return (err as { network?: boolean })?.network === true;
  }
}
const apiErr = (code: string) => { const e = new Error(code) as Error & { code: string }; e.code = code; return e; };
const netErr = () => { const e = new Error("offline") as Error & { network: boolean }; e.network = true; return e; };

describe("exceptionOutboxCore — queue ops", () => {
  it("merges by clientOccurrenceId (upsert, not duplicate)", () => {
    let items: ExceptionOutboxItem[] = [];
    items = mergeOutboxItem(items, patch(), "q1");
    items = mergeOutboxItem(items, patch({ reason: "updated" }), "q2");
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe("updated");
    expect(items[0].queuedAt).toBe("q1"); // original queuedAt preserved
  });

  it("caps the queue at MAX_OUTBOX (drops oldest)", () => {
    let items: ExceptionOutboxItem[] = [];
    for (let i = 0; i < MAX_OUTBOX + 3; i++) {
      items = mergeOutboxItem(items, patch({ clientOccurrenceId: `occ-${i}` }), `q${i}`);
    }
    expect(items).toHaveLength(MAX_OUTBOX);
    expect(items[0].clientOccurrenceId).toBe("occ-3"); // first 3 dropped
  });
});

describe("exceptionOutboxCore — flush", () => {
  it("a successful report → synced (removed on reconcile)", async () => {
    const api = new FakeApi();
    const stored = [item()];
    const { outcomes, synced } = await flushOutboxItems(stored, api);
    expect(synced).toBe(1);
    expect(reconcileOutboxAfterFlush(stored, outcomes)).toHaveLength(0);
  });

  it("a network error → kept for retry", async () => {
    const api = new FakeApi(() => { throw netErr(); });
    const stored = [item()];
    const { outcomes } = await flushOutboxItems(stored, api);
    expect(outcomes[0].outcome).toBe("kept");
    expect(reconcileOutboxAfterFlush(stored, outcomes)).toHaveLength(1);
  });

  it("EXCEPTION_ALREADY_OPEN (a different open exception) → dropped as stale", async () => {
    const api = new FakeApi(() => { throw apiErr("EXCEPTION_ALREADY_OPEN"); });
    const stored = [item()];
    const { outcomes, dropped } = await flushOutboxItems(stored, api);
    expect(dropped).toBe(1);
    expect(reconcileOutboxAfterFlush(stored, outcomes)).toHaveLength(0);
  });

  it("an unexpected API error retries then drops at MAX_API_FAILURES", async () => {
    const api = new FakeApi(() => { throw apiErr("SERVER_ERROR"); });
    let stored = [item()];
    for (let attempt = 1; attempt < MAX_API_FAILURES; attempt++) {
      const { outcomes } = await flushOutboxItems(stored, api);
      expect(outcomes[0].outcome).toBe("kept");
      stored = reconcileOutboxAfterFlush(stored, outcomes);
      expect(stored[0].apiFailures).toBe(attempt);
    }
    const { outcomes } = await flushOutboxItems(stored, api);
    expect(outcomes[0].outcome).toBe("dropped");
    expect(reconcileOutboxAfterFlush(stored, outcomes)).toHaveLength(0);
  });

  it("reconcile keeps an item re-queued mid-flush (different queuedAt)", async () => {
    const api = new FakeApi();
    const flushing = [item({ queuedAt: "old" })];
    const { outcomes } = await flushOutboxItems(flushing, api);
    // The stored queue now holds the SAME occurrence re-queued with a new time.
    const storedNow = [item({ queuedAt: "new" })];
    const result = reconcileOutboxAfterFlush(storedNow, outcomes);
    expect(result).toHaveLength(1); // the re-queued intent survives
    expect(result[0].queuedAt).toBe("new");
  });
});
