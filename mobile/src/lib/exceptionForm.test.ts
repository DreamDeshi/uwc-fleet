import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import {
  EXCEPTION_CATEGORIES,
  validateExceptionForm,
  canDriverAddEvidence,
  isOpenState,
  exceptionStateLabelKey,
  requestorReasonLabelKey,
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

/**
 * C9 — the requestor is shown the REASON, never the pay decision (Mr. Teh,
 * 11 Aug 2026, "OPTION B").
 *
 * ⚠ WHAT DISCRIMINATES. The banner used to render `exception.category.*`, the
 * DRIVER'S PICKER labels. A test that only checked "a label exists" would have
 * passed against those, so the cases below assert the requestor copy is present
 * in all three locales AND is NOT the picker string — the whole point of the
 * change is that the two differ.
 *
 * The banner cannot be rendered here (mobile has no RN renderer in the test
 * setup — every spec in src/**\/*.test.ts is pure logic), so the last case reads
 * the component source and fails if it stops calling this key builder. Proven
 * by putting `t(\`exception.category.${view.category}\`)` back: that case goes
 * red, and nothing else in the mobile suite notices.
 */
describe("C9 — requestor-facing reason labels", () => {
  const LOCALES = ["en", "ms", "zh"] as const;
  const bundles = Object.fromEntries(
    LOCALES.map((l) => [l, require(`../i18n/${l}.json`) as Record<string, any>])
  ) as Record<(typeof LOCALES)[number], Record<string, any>>;

  it("gives every confirmed category a key, and unknown input NO key", () => {
    for (const { key } of EXCEPTION_CATEGORIES) {
      expect(requestorReasonLabelKey(key)).toBe(`exception.requestorReason.${key}`);
    }
    // A raw i18n key must never reach a customer's screen.
    for (const junk of ["", "unknown", "reason", "customer site"]) {
      expect(requestorReasonLabelKey(junk)).toBeNull();
    }
  });

  it("every key resolves in en, ms AND zh — a requestor who reads Malay sees Malay", () => {
    const missing: string[] = [];
    for (const { key } of EXCEPTION_CATEGORIES) {
      for (const locale of LOCALES) {
        const value = bundles[locale].exception?.requestorReason?.[key];
        if (typeof value !== "string" || value.trim() === "") missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("reads as a REASON, not as the driver's filing category", () => {
    // The defect C9 fixes: "Customer / Site" is a taxonomy bucket. If a locale
    // ever copies the picker label into the requestor slot, that is the bug
    // coming back, not a translation choice.
    const same: string[] = [];
    for (const { key } of EXCEPTION_CATEGORIES) {
      for (const locale of LOCALES) {
        const reason = bundles[locale].exception.requestorReason[key] as string;
        const picker = bundles[locale].exception.category[key] as string;
        if (reason === picker) same.push(`${locale}: ${key}`);
      }
    }
    expect(same).toEqual([]);
  });

  it("says nothing about pay, in any locale", () => {
    // C9's other half. The redacted payload carries no money field, so this is
    // belt and braces on the COPY: no label may imply a pay outcome.
    const MONEY = /\bRM\b|pay|paid|incentive|claim|bayar|gaji|insentif|工资|付款|报酬|奖励/i;
    for (const { key } of EXCEPTION_CATEGORIES) {
      for (const locale of LOCALES) {
        expect(bundles[locale].exception.requestorReason[key]).not.toMatch(MONEY);
      }
    }
  });

  it("the banner ACTUALLY uses it — the call site, not just the helper", () => {
    const src = readFileSync(
      join(__dirname, "..", "components", "RequestorExceptionBanner.tsx"),
      "utf8"
    );
    // Guard against the vacuous version of this test: if the file moved, an
    // empty read would satisfy every `not.toContain` below.
    expect(src.length).toBeGreaterThan(200);
    expect(src).toContain("requestorReasonLabelKey");
    // …and no longer renders the driver's picker label to a requestor.
    expect(src).not.toContain("exception.category.");
  });
});
