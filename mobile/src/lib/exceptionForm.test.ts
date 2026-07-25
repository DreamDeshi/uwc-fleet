import { describe, it, expect } from "vitest";
import {
  EXCEPTION_CATEGORIES,
  validateExceptionForm,
  canDriverAddEvidence,
  isOpenState,
  exceptionStateLabelKey,
  toRequestorView,
} from "./exceptionForm";
import type { PickedPhoto } from "./photo";

const photo: PickedPhoto = { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" };

describe("exception form validation", () => {
  it("has exactly the five confirmed categories", () => {
    expect(EXCEPTION_CATEGORIES.map((c) => c.key)).toEqual(["customer_site", "truck", "cargo", "external", "documentation"]);
  });

  it("requires a valid category", () => {
    expect(validateExceptionForm({ category: null, reason: "x", photo })).toBe("exception.validation.categoryRequired");
    expect(validateExceptionForm({ category: "bogus", reason: "x", photo })).toBe("exception.validation.categoryRequired");
  });
  it("requires a non-empty reason", () => {
    expect(validateExceptionForm({ category: "truck", reason: "   ", photo })).toBe("exception.validation.reasonRequired");
  });
  it("rejects an over-long reason", () => {
    expect(validateExceptionForm({ category: "truck", reason: "a".repeat(2001), photo })).toBe("exception.validation.reasonTooLong");
  });
  it("requires a photo", () => {
    expect(validateExceptionForm({ category: "truck", reason: "broke down", photo: null })).toBe("exception.validation.photoRequired");
  });
  it("passes a complete form", () => {
    expect(validateExceptionForm({ category: "customer_site", reason: "gate locked", photo })).toBeNull();
  });
});

describe("exception state helpers", () => {
  it("open vs closed", () => {
    expect(isOpenState("reported")).toBe(true);
    expect(isOpenState("more_evidence")).toBe(true);
    expect(isOpenState("verified")).toBe(true);
    expect(isOpenState("resolved")).toBe(false);
    expect(isOpenState("rejected")).toBe(false);
  });
  it("driver may add evidence ONLY when asked (more_evidence)", () => {
    expect(canDriverAddEvidence("more_evidence")).toBe(true);
    for (const s of ["reported", "verified", "rejected", "resolved"]) expect(canDriverAddEvidence(s)).toBe(false);
  });
  it("state label key", () => {
    expect(exceptionStateLabelKey("verified")).toBe("exception.state.verified");
  });
});

describe("requestor redaction (defense-in-depth)", () => {
  it("exposes ONLY safe fields, even from a full payload", () => {
    const full = {
      id: "x", category: "customer_site", reason: "SENSITIVE internal detail",
      status: "open",
      reported_at: "2026-08-01T02:00:00.000Z", resolved_at: null, stop_sequence: 2,
      actions: [{ note: "secret", lat: 5.2, lng: 100.4, actor_id: "u1" }],
      evidence: [{ url: "https://cloud/secret.jpg", public_id: "p" }],
      version: 3, reported_by: "driver1",
    };
    const view = toRequestorView(full) as unknown as Record<string, unknown>;
    expect(view.category).toBe("customer_site");
    expect(view.status).toBe("open");
    expect(view.stopSequence).toBe(2);
    expect(view.reportedAt).toBe("2026-08-01T02:00:00.000Z");
    // Nothing sensitive is present on the projection.
    expect(JSON.stringify(view)).not.toContain("SENSITIVE");
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(JSON.stringify(view)).not.toContain("cloud/");
    expect((view as { actions?: unknown }).actions).toBeUndefined();
    expect((view as { evidence?: unknown }).evidence).toBeUndefined();
    expect((view as { reason?: unknown }).reason).toBeUndefined();
    expect((view as { reported_by?: unknown }).reported_by).toBeUndefined();
  });
  it("derives status from closed_at if the server sent a full payload", () => {
    expect(toRequestorView({ category: "truck", closed_at: "2026-08-01T05:00:00Z" })?.status).toBe("resolved");
    expect(toRequestorView({ category: "truck", closed_at: null })?.status).toBe("open");
  });
  it("returns null for no exception", () => {
    expect(toRequestorView(null)).toBeNull();
    expect(toRequestorView(undefined)).toBeNull();
  });
});
