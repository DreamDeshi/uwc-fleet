// Pure decision for the app-launch session bootstrap — import-free so it's
// unit-testable in plain node (same discipline as gpsTracking / podOutboxCore).
//
// The bug this guards: on a COLD start with NO signal, GET /users/me fails with
// a network error (no HTTP response). Treating that like a real auth rejection
// wipes the driver's tokens and forces re-login — locking an offline driver out
// of their own active trip. The rule: a connectivity failure KEEPS the session
// (the token is still valid as far as we know; re-validate when signal returns);
// only a genuine server rejection (any HTTP response — e.g. a 401 whose refresh
// also failed) CLEARS it. This never weakens real auth expiry: an expired token
// yields a 401 response, which is "clear".

// A request that never got a server reply — offline, DNS failure, timeout,
// connection dropped. Mirrors services/api.ts `isNetworkError` but with no axios
// import so this stays pure. Anything WITH a response is a server decision.
export function isConnectivityError(err: unknown): boolean {
  const ax = err as { isAxiosError?: boolean; response?: unknown } | null | undefined;
  if (!ax?.isAxiosError) return false;
  return !ax.response;
}

export type BootstrapAction = "keep" | "clear";

// "keep" → stay authed on the stored token (offline); "clear" → drop to login.
export function bootstrapActionForError(err: unknown): BootstrapAction {
  return isConnectivityError(err) ? "keep" : "clear";
}
