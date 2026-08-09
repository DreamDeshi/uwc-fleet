// The POD viewer's expiry state machine, kept OUT of the component so it can
// be tested. There is no component-test harness in this workspace — every other
// piece of decision logic here lives in a pure lib with a spec beside it, and
// this is the one part of the viewer that can strand a user on a spinner.
//
// The problem it solves: a POD's delivery URL is signed and SHORT-LIVED
// (CLOUDINARY_POD_URL_TTL_SECONDS, one hour by default) and the asset itself is
// `type: "authenticated"` — the unsigned URL 401s. A list loaded an hour ago
// therefore holds dead URLs, and opening one is EXPECTED to fail on first
// paint. The fix is a fresh signature, not an error message; the server re-signs
// on every read, so a refetch of the owning query is all it takes.

export type PodStatus = "loading" | "ok" | "refreshing" | "failed";

export type PodState = {
  status: PodStatus;
  /**
   * The URL we last asked the server to re-sign. `null` means we have not
   * spent our one refresh attempt yet.
   */
  refreshedFrom: string | null;
};

export type PodEvent =
  | { type: "url"; url: string }
  | { type: "error"; url: string }
  | { type: "loaded" }
  | { type: "retry" };

/** What the caller must do after a transition. */
export type PodEffect = { state: PodState; refresh: boolean };

export const podInitialState: PodState = { status: "loading", refreshedFrom: null };

export function podViewerReducer(state: PodState, event: PodEvent): PodEffect {
  switch (event.type) {
    case "loaded":
      return { state: { status: "ok", refreshedFrom: null }, refresh: false };

    case "error":
      // One attempt only. A failure AFTER a fresh signature is a real failure —
      // the asset is missing, the network is down, or the account lost access —
      // and retrying forever would just spin.
      if (state.refreshedFrom !== null) {
        return { state: { ...state, status: "failed" }, refresh: false };
      }
      return { state: { status: "refreshing", refreshedFrom: event.url }, refresh: true };

    case "url":
      // ⚠ THE STUCK-SPINNER CASE. If the refetch resolves with the SAME URL we
      // just asked to be re-signed, the <Image> will not remount and no further
      // error will ever fire, so waiting is waiting forever. That is a failure,
      // not a load.
      if (state.refreshedFrom === event.url) {
        return { state: { ...state, status: "failed" }, refresh: false };
      }
      // A genuinely new URL: fresh attempt, and the refresh budget resets.
      return { state: { status: "loading", refreshedFrom: null }, refresh: false };

    case "retry":
      // Explicit user action, so the budget resets with it.
      return { state: { status: "loading", refreshedFrom: null }, refresh: true };
  }
}
