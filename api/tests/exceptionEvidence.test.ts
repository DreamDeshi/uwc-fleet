import { vi, describe, it, expect } from "vitest";

// Mock the Cloudinary adapter so the real signing path (podPhotos.signedAssetUrl)
// runs with no network — we assert the CONTRACT: exception evidence is signed as
// an AUTHENTICATED (private) asset, in its own folder, separate from POD.
// vi.hoisted so the spy exists before the hoisted vi.mock factory runs.
const { urlSpy } = vi.hoisted(() => ({
  urlSpy: vi.fn((publicId: string, opts: Record<string, unknown>) => `signed://${publicId}?type=${opts.type}&sign=${opts.sign_url}`),
}));
vi.mock("../src/lib/cloudinary", () => ({
  cloudinary: { url: urlSpy },
  isCloudinaryConfigured: () => true,
}));

import {
  EXCEPTION_EVIDENCE_FOLDER,
  signExceptionEvidenceUrl,
  serializeException,
  type ExceptionAggregate,
} from "../src/lib/exceptionEvidence";

function aggregate(): ExceptionAggregate {
  return {
    id: "exc1",
    trip_id: "trip1",
    trip_stop_id: null,
    category: "customer_site",
    reason: "gate locked",
    reported_by: "driver1",
    reported_at: new Date("2026-08-01T02:00:00Z"),
    client_reported_at: null,
    current_state: "reported",
    resolution: null,
    resolved_at: null,
    closed_at: null,
    version: 0,
    created_at: new Date("2026-08-01T02:00:00Z"),
    actions: [
      { id: "a1", type: "report", resolution: null, actor_id: "driver1", actor_role: "driver", note: "n", lat: 5.28, lng: 100.46, accuracy_m: 12, client_at: null, created_at: new Date() },
    ],
    evidence: [
      { id: "e1", kind: "photo", public_id: "uwc/exceptions/pub_1", created_at: new Date(), captured_client_at: null, action_id: "a1" },
    ],
  };
}

describe("exception evidence — Cloudinary adapter contract", () => {
  it("uses a folder SEPARATE from POD", () => {
    expect(EXCEPTION_EVIDENCE_FOLDER).toBe("uwc/exceptions");
    expect(EXCEPTION_EVIDENCE_FOLDER).not.toBe("uwc/pod");
  });

  it("signs evidence as an AUTHENTICATED (private) asset", () => {
    const url = signExceptionEvidenceUrl("uwc/exceptions/pub_1");
    expect(url).toContain("uwc/exceptions/pub_1");
    const lastCall = urlSpy.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("uwc/exceptions/pub_1");
    expect((lastCall[1] as Record<string, unknown>).type).toBe("authenticated");
    expect((lastCall[1] as Record<string, unknown>).sign_url).toBe(true);
  });
});

describe("exception evidence — role-scoped serialization (redaction)", () => {
  it("redacted (requestor) view omits reason, actions, evidence, GPS", () => {
    const red = serializeException(aggregate(), "redacted") as Record<string, unknown>;
    expect(red.category).toBe("customer_site");
    expect(red.status).toBe("open");
    expect(red.reason).toBeUndefined();
    expect(red.actions).toBeUndefined();
    expect(red.evidence).toBeUndefined();
    expect(red.reported_by).toBeUndefined();
  });

  it("full view exposes actions + SIGNED evidence URLs but never the raw public_id", () => {
    const full = serializeException(aggregate(), "full") as {
      evidence: { url: string; public_id?: string }[];
      actions: { lat: number | null }[];
    };
    expect(full.evidence[0].url).toContain("signed://uwc/exceptions/pub_1");
    expect(full.evidence[0].public_id).toBeUndefined(); // handle never leaves the server
    expect(full.actions[0].lat).toBe(5.28);
  });
});
