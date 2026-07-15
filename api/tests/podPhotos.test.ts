import { describe, it, expect, beforeAll } from "vitest";
import { cloudinary } from "../src/lib/cloudinary";
import {
  podPublicIdFromUrl,
  signedPodUrl,
  signedAssetUrl,
  documentAssetFromUrl,
  signTripResponse,
} from "../src/lib/podPhotos";

// Give the shared cloudinary singleton a deterministic config so signed URLs are
// reproducible — the real CLOUDINARY_* env isn't present in unit tests.
beforeAll(() => {
  cloudinary.config({ cloud_name: "testcloud", api_key: "k", api_secret: "s", secure: true });
});

describe("podPublicIdFromUrl", () => {
  it("parses a public upload URL (version + extension stripped)", () => {
    expect(
      podPublicIdFromUrl(
        "https://res.cloudinary.com/dultrxlvm/image/upload/v1699999999/uwc/pod/TKT-20260715-001-stop-1.jpg"
      )
    ).toBe("uwc/pod/TKT-20260715-001-stop-1");
  });

  it("parses an authenticated, signed URL", () => {
    expect(
      podPublicIdFromUrl(
        "https://res.cloudinary.com/dultrxlvm/image/authenticated/s--abcd1234--/v1699999999/uwc/pod/TKT-20260715-001-stop-2.png"
      )
    ).toBe("uwc/pod/TKT-20260715-001-stop-2");
  });

  it("parses a URL without a version segment", () => {
    expect(
      podPublicIdFromUrl("https://res.cloudinary.com/dultrxlvm/image/upload/uwc/pod/TKT-x-stop-1.jpg")
    ).toBe("uwc/pod/TKT-x-stop-1");
  });

  it("returns null for a non-Cloudinary URL", () => {
    expect(podPublicIdFromUrl("https://example.com/whatever.jpg")).toBeNull();
    expect(podPublicIdFromUrl("test://pod.jpg")).toBeNull();
  });
});

describe("signedPodUrl", () => {
  it("builds an authenticated, signed, unguessable URL for a public_id", () => {
    const url = signedPodUrl("uwc/pod/TKT-20260715-001-stop-1");
    expect(url.startsWith("https://")).toBe(true);
    expect(url).toContain("testcloud");
    expect(url).toContain("/authenticated/"); // private delivery type
    expect(url).toContain("s--"); // signature — needs the API secret to forge
    expect(url).toContain("uwc/pod/TKT-20260715-001-stop-1");
  });
});

describe("signedAssetUrl (documents) — resource_type + format aware", () => {
  it("preserves the extension for image assets (client detects image-vs-PDF from the URL)", () => {
    const url = signedAssetUrl("uwc/documents/abc123", { resourceType: "image", format: "jpg" });
    expect(url).toContain("/image/authenticated/");
    expect(url).toContain("s--");
    expect(url).toMatch(/uwc\/documents\/abc123\.jpg/);
  });

  it("keeps a PDF's .pdf extension", () => {
    const url = signedAssetUrl("uwc/documents/inv999", { resourceType: "image", format: "pdf" });
    expect(url).toMatch(/uwc\/documents\/inv999\.pdf/);
  });

  it("signs a raw asset without double-appending its extension", () => {
    const url = signedAssetUrl("uwc/documents/notes.docx", { resourceType: "raw" });
    expect(url).toContain("/raw/authenticated/");
    expect(url).toContain("s--");
    expect(url).toContain("uwc/documents/notes.docx");
    expect(url).not.toMatch(/\.docx\.docx/);
  });
});

describe("documentAssetFromUrl", () => {
  it("parses an image document (extension → format, stripped from public_id)", () => {
    expect(
      documentAssetFromUrl("https://res.cloudinary.com/c/image/upload/v123/uwc/documents/abc123.jpg")
    ).toEqual({ publicId: "uwc/documents/abc123", resourceType: "image", format: "jpg" });
  });

  it("parses a raw document (extension KEPT in the public_id)", () => {
    expect(
      documentAssetFromUrl("https://res.cloudinary.com/c/raw/upload/v123/uwc/documents/notes.docx")
    ).toEqual({ publicId: "uwc/documents/notes.docx", resourceType: "raw", format: "docx" });
  });

  it("parses an authenticated signed document URL", () => {
    expect(
      documentAssetFromUrl("https://res.cloudinary.com/c/image/authenticated/s--x--/v1/uwc/documents/d.pdf")
    ).toEqual({ publicId: "uwc/documents/d", resourceType: "image", format: "pdf" });
  });

  it("returns null for a non-Cloudinary URL", () => {
    expect(documentAssetFromUrl("https://example.com/file.pdf")).toBeNull();
  });
});

describe("signTripResponse", () => {
  const stopWithId = {
    id: "s1",
    pod_public_id: "uwc/pod/TKT-A-stop-1",
    pod_photo: "https://res.cloudinary.com/testcloud/image/authenticated/uwc/pod/TKT-A-stop-1",
  };
  const legacyStop = {
    id: "s2",
    pod_public_id: null,
    pod_photo: "https://res.cloudinary.com/testcloud/image/upload/uwc/pod/OLD-stop-1.jpg",
  };

  it("replaces pod_photo with a signed URL when the stop has a pod_public_id", () => {
    const out = signTripResponse({ id: "t1", stops: [stopWithId] }) as { stops: { pod_photo: string }[] };
    expect(out.stops[0].pod_photo).toContain("/authenticated/");
    expect(out.stops[0].pod_photo).toContain("s--");
    expect(out.stops[0].pod_photo).not.toBe(stopWithId.pod_photo); // signed, not the stored value
  });

  it("leaves a legacy stop (no public_id) untouched", () => {
    const out = signTripResponse({ id: "t1", stops: [legacyStop] }) as { stops: { pod_photo: string }[] };
    expect(out.stops[0].pod_photo).toBe(legacyStop.pod_photo);
  });

  it("handles an array of trips and a keyset page", () => {
    const arr = signTripResponse([{ stops: [stopWithId] }]) as { stops: { pod_photo: string }[] }[];
    expect(arr[0].stops[0].pod_photo).toContain("s--");

    const page = signTripResponse({ items: [{ stops: [stopWithId] }], next_cursor: null }) as {
      items: { stops: { pod_photo: string }[] }[];
      next_cursor: null;
    };
    expect(page.items[0].stops[0].pod_photo).toContain("s--");
    expect(page.next_cursor).toBeNull();
  });

  it("passes non-trip payloads through unchanged (no stops)", () => {
    expect(signTripResponse({ message: "ok" })).toEqual({ message: "ok" });
    expect(signTripResponse({ polyline: [], distance_m: 5 })).toEqual({ polyline: [], distance_m: 5 });
  });

  const docWithId = {
    id: "d1",
    public_id: "uwc/documents/abc123",
    resource_type: "image",
    format: "jpg",
    file_url: "https://res.cloudinary.com/testcloud/image/authenticated/uwc/documents/abc123",
  };
  const legacyDoc = {
    id: "d2",
    public_id: null,
    file_url: "https://res.cloudinary.com/testcloud/image/upload/uwc/documents/old.pdf",
  };

  it("signs a document's file_url when it has a public_id (extension preserved)", () => {
    const out = signTripResponse({ id: "t1", stops: [], documents: [docWithId] }) as {
      documents: { file_url: string }[];
    };
    expect(out.documents[0].file_url).toContain("/authenticated/");
    expect(out.documents[0].file_url).toContain("s--");
    expect(out.documents[0].file_url).toMatch(/uwc\/documents\/abc123\.jpg/);
    expect(out.documents[0].file_url).not.toBe(docWithId.file_url);
  });

  it("leaves a legacy document (no public_id) untouched", () => {
    const out = signTripResponse({ id: "t1", documents: [legacyDoc] }) as { documents: { file_url: string }[] };
    expect(out.documents[0].file_url).toBe(legacyDoc.file_url);
  });

  it("signs stops AND documents on the same trip", () => {
    const out = signTripResponse({
      stops: [{ id: "s1", pod_public_id: "uwc/pod/TKT-A-stop-1", pod_photo: "x" }],
      documents: [docWithId],
    }) as { stops: { pod_photo: string }[]; documents: { file_url: string }[] };
    expect(out.stops[0].pod_photo).toContain("s--");
    expect(out.documents[0].file_url).toContain("s--");
  });
});
