// Deterministic interleaving barriers for concurrency TESTS only.
//
// A route awaits `testHook(name)` at a critical point (e.g. just before a
// transaction commits, while it still holds the Trip row lock). In production the
// barrier map is empty AND NODE_ENV is not "test", so `testHook` returns
// immediately — zero behavioural or measurable-latency effect. A test arms a
// barrier, fires request A (which pauses at the hook holding its lock), waits
// until A has reached the hook, fires request B (which blocks on the lock),
// releases A, and thereby forces the exact interleaving instead of racing on
// Promise.all and hoping.

interface Barrier {
  signalReached: () => void;
  gate: Promise<void>;
}

const barriers = new Map<string, Barrier>();

/** TEST-ONLY: arm a one-shot barrier. Returns a promise that resolves when the
 *  route reaches the hook, and a `release` to let it proceed. */
export function armBarrier(name: string): { reached: Promise<void>; release: () => void } {
  let signalReached!: () => void;
  const reached = new Promise<void>((r) => (signalReached = r));
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => (releaseGate = r));
  barriers.set(name, { signalReached, gate });
  return { reached, release: () => releaseGate() };
}

/** Awaited by production code at a critical section. No-op unless a test armed a
 *  matching barrier (and we are running under NODE_ENV=test). One-shot. */
export async function testHook(name: string): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const b = barriers.get(name);
  if (!b) return;
  barriers.delete(name); // one-shot: subsequent calls pass straight through
  b.signalReached();
  await b.gate;
}
