import { describe, it, expect } from "vitest";
import { sha256Hex, reportFingerprint, evidenceFingerprint, type ReportFingerprintInput, type EvidenceIdentityInput } from "../src/lib/exceptionFingerprint";

const baseReport = (): ReportFingerprintInput => ({
  tripId: "t1", tripStopId: null, category: "customer_site", reason: "gate locked",
  reportedBy: "d1", clientActionId: "a1", clientEvidenceId: "e1",
  lat: 5.28, lng: 100.46, accuracyM: 12,
  clientReportedAt: new Date("2026-08-01T02:00:00Z"), capturedClientAt: null,
  photoSha256: "abc123",
});
const baseEvidence = (): EvidenceIdentityInput => ({
  exceptionId: "x1", kind: "photo", uploadedBy: "d1",
  capturedClientAt: new Date("2026-08-01T02:00:00Z"), photoSha256: "abc123",
});

describe("exceptionFingerprint", () => {
  it("sha256Hex is deterministic and content-sensitive", () => {
    expect(sha256Hex(Buffer.from("hello"))).toBe(sha256Hex(Buffer.from("hello")));
    expect(sha256Hex(Buffer.from("hello"))).not.toBe(sha256Hex(Buffer.from("hellp")));
  });

  it("reportFingerprint: identical inputs match", () => {
    expect(reportFingerprint(baseReport())).toBe(reportFingerprint(baseReport()));
  });

  it("reportFingerprint changes when ANY semantic field changes", () => {
    const base = reportFingerprint(baseReport());
    const mutations: Partial<ReportFingerprintInput>[] = [
      { tripStopId: "s1" }, { category: "cargo" }, { reason: "changed" }, { reportedBy: "d2" },
      { clientActionId: "a2" }, { clientEvidenceId: "e2" }, { lat: 5.29 }, { lng: 100.47 },
      { accuracyM: 13 }, { clientReportedAt: new Date("2026-08-01T03:00:00Z") },
      { capturedClientAt: new Date("2026-08-01T02:00:00Z") }, { photoSha256: "def456" },
    ];
    for (const m of mutations) {
      expect(reportFingerprint({ ...baseReport(), ...m })).not.toBe(base);
    }
  });

  it("evidenceFingerprint changes on content, timestamp, actor, exception or kind change", () => {
    const base = evidenceFingerprint(baseEvidence());
    expect(evidenceFingerprint({ ...baseEvidence(), photoSha256: "zzz" })).not.toBe(base);
    expect(evidenceFingerprint({ ...baseEvidence(), capturedClientAt: new Date("2026-08-01T09:00:00Z") })).not.toBe(base);
    expect(evidenceFingerprint({ ...baseEvidence(), uploadedBy: "d2" })).not.toBe(base);
    expect(evidenceFingerprint({ ...baseEvidence(), exceptionId: "x2" })).not.toBe(base);
    expect(evidenceFingerprint({ ...baseEvidence(), kind: "video" })).not.toBe(base);
    expect(evidenceFingerprint(baseEvidence())).toBe(base); // stable
  });
});
