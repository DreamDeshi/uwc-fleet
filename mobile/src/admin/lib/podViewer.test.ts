import { describe, it, expect } from "vitest";
import { podInitialState, podViewerReducer, type PodState } from "./podViewer";

const OLD = "https://res.cloudinary.com/x/pod.jpg?sig=expired";
const NEW = "https://res.cloudinary.com/x/pod.jpg?sig=fresh";

describe("podViewerReducer", () => {
  it("an expired URL asks for exactly one re-sign", () => {
    const r = podViewerReducer(podInitialState, { type: "error", url: OLD });
    expect(r.refresh).toBe(true);
    expect(r.state.status).toBe("refreshing");
    expect(r.state.refreshedFrom).toBe(OLD);
  });

  it("a fresh URL arriving starts a clean attempt", () => {
    const refreshing: PodState = { status: "refreshing", refreshedFrom: OLD };
    const r = podViewerReducer(refreshing, { type: "url", url: NEW });
    expect(r.state.status).toBe("loading");
    expect(r.state.refreshedFrom).toBeNull(); // budget resets for the new URL
    expect(r.refresh).toBe(false);
  });

  it("STUCK-SPINNER: a refetch returning the SAME URL fails instead of waiting", () => {
    // The <Image> is keyed on the URL, so an unchanged URL never remounts and
    // never fires another error. Waiting here would hang the modal forever.
    const refreshing: PodState = { status: "refreshing", refreshedFrom: OLD };
    const r = podViewerReducer(refreshing, { type: "url", url: OLD });
    expect(r.state.status).toBe("failed");
    expect(r.refresh).toBe(false);
  });

  it("a second failure after re-signing is a real failure, not another retry", () => {
    const afterRefresh: PodState = { status: "loading", refreshedFrom: OLD };
    const r = podViewerReducer(afterRefresh, { type: "error", url: NEW });
    expect(r.state.status).toBe("failed");
    expect(r.refresh).toBe(false);
  });

  it("never asks for more than one automatic re-sign in a row", () => {
    // Drive the loop the component would: error → refresh → error → …
    let state = podInitialState;
    let refreshes = 0;
    for (let i = 0; i < 5; i++) {
      const r = podViewerReducer(state, { type: "error", url: OLD });
      state = r.state;
      if (r.refresh) refreshes++;
    }
    expect(refreshes).toBe(1);
    expect(state.status).toBe("failed");
  });

  it("loading succeeds", () => {
    const r = podViewerReducer({ status: "refreshing", refreshedFrom: OLD }, { type: "loaded" });
    expect(r.state.status).toBe("ok");
    expect(r.state.refreshedFrom).toBeNull();
  });

  it("an explicit retry re-signs again and restores the budget", () => {
    const failed: PodState = { status: "failed", refreshedFrom: OLD };
    const r = podViewerReducer(failed, { type: "retry" });
    expect(r.refresh).toBe(true);
    expect(r.state.status).toBe("loading");
    expect(r.state.refreshedFrom).toBeNull();
  });

  it("a retry that leads to another expiry can re-sign once more", () => {
    // Retry is a deliberate user action, so the one-shot budget is per attempt,
    // not per modal open — otherwise the Try Again button would do nothing on a
    // link that expired twice.
    let { state } = podViewerReducer({ status: "failed", refreshedFrom: OLD }, { type: "retry" });
    const r = podViewerReducer(state, { type: "error", url: NEW });
    expect(r.refresh).toBe(true);
    expect(r.state.status).toBe("refreshing");
  });
});
