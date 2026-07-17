/**
 * Compile-time exhaustiveness guard for a `switch`/if-chain over a union
 * (`TripStatus`, `TripEvent`, `StopStatus`, …).
 *
 * Call it in the branch that must be unreachable. Every union member handled →
 * `value` narrows to `never` and this compiles. Miss one — or add a new member
 * later — and `value` is no longer `never`, so the BUILD fails at that site
 * instead of the miss becoming a silent wrong answer at runtime.
 *
 * ⚠ It only works if the branch is genuinely unreachable. A guard placed behind
 * a catch-all that returns a real value (`default: return somethingSensible`)
 * is dead code and changes nothing — the catch-all is precisely what swallows
 * the new member. Delete the catch-all and REPLACE it with this.
 *
 * Why it exists: `pending_approval` was added to TripStatus by the POD approval
 * gate (item 9) and every consumer kept compiling. In this file's own case, the
 * requestor analytics switch had no arm for it, so such a trip was counted in
 * NO bucket — quietly falsifying the "buckets always sum to total" contract the
 * code documented one line above itself.
 *
 * Throwing is the runtime fallback, not the purpose. For a Prisma enum column
 * the value is constrained by the database, so this is unreachable in practice;
 * it fires only if a value escapes the union entirely.
 */
export function assertNever(value: never, context = "value"): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
