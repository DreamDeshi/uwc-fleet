import { describe, it, expect, beforeAll } from "vitest";

/**
 * DELIVERY OPTIMISATION — q_auto / f_auto on signed asset URLs.
 *
 * The point of this file is not that the parameters are present. It is that they
 * are present on EXACTLY the assets that can take them, because both ways of
 * getting it wrong are silent:
 *
 *   • f_auto on a PDF renders page one and drops the rest. The document still
 *     loads, still looks like a document, and is missing pages. Nothing logs it.
 *   • f_auto on any document strips the file extension, and the requestor's
 *     paperwork row decides image-vs-PDF by regexing that extension off the URL.
 *     Thumbnails would quietly become bare links.
 *
 * Neither failure raises an error, so neither would be caught by a test that only
 * asserted "the URL still resolves".
 */

type Signer = typeof import("../src/lib/podPhotos");
let pod: Signer;

/**
 * The LITERAL rule from mobile/src/screens/requestor/BookingDetailScreen.tsx.
 * Copied deliberately: this test's job is to prove the API keeps the client's
 * assumption true, so it asserts the client's actual rule, not a paraphrase.
 *
 * ⚠ The `.split(/[?#]/)[0]` is load-bearing and this test is why it exists. The
 * client used to anchor `$` against the whole URL, but Cloudinary appends an SDK
 * analytics parameter (`?_a=...`) to every delivery URL — so the rule was false
 * for EVERY document and every image rendered as a file icon. Pre-existing, not
 * caused by optimisation; this suite found it on the first run.
 */
const clientSeesAnImage = (url: string) =>
  /\.(jpe?g|png|webp|heic|gif)$/i.test(url.split(/[?#]/)[0]);

beforeAll(async () => {
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "123456789012345";
  process.env.CLOUDINARY_API_SECRET = "test-secret-not-a-real-key";
  delete process.env.E2E_STUB_UPLOADS;
  delete process.env.CLOUDINARY_POD_TOKEN_KEY;
  pod = await import("../src/lib/podPhotos");
});

describe("POD and K2 photos take the full treatment", () => {
  it("carries BOTH q_auto and f_auto", () => {
    const url = pod.signedPodUrl("uwc/pod/TKT-0001-stop-1");
    expect(url).toContain("q_auto");
    expect(url).toContain("f_auto");
  });

  it("is still a SIGNED authenticated URL — optimisation must not cost the privacy fix", () => {
    const url = pod.signedPodUrl("uwc/pod/TKT-0001-stop-1");
    expect(url).toContain("/authenticated/");
    // Cloudinary's signature segment. Without it the asset is unreachable, which
    // is the whole point of uploading POD photos as private assets.
    expect(url).toMatch(/\/s--[^/]+--\//);
  });
});

describe("the K2 customs document is NEVER format-converted", () => {
  /**
   * K2 shares POD's storage columns and had shared its signer. The moment PDF
   * uploads were allowed on the K2 route, that sharing became a bug: a Borang K2
   * runs to several pages, f_auto keeps only the first, and the admin validating
   * it is the person who releases pay. The document would look complete.
   */
  it("carries NEITHER q_auto nor f_auto", () => {
    const url = pod.signedK2Url("uwc/k2/TKT-0001-stop-1-k2");
    expect(url).not.toContain("f_auto");
    expect(url).not.toContain("q_auto");
  });

  it("is still signed and authenticated — dropping optimisation must not drop privacy", () => {
    const url = pod.signedK2Url("uwc/k2/TKT-0001-stop-1-k2");
    expect(url).toContain("/authenticated/");
    expect(url).toMatch(/\/s--[^/]+--\//);
  });

  it("differs from the POD signer, which is the whole point", () => {
    const k2 = pod.signedK2Url("uwc/shared/same-id");
    const podUrl = pod.signedPodUrl("uwc/shared/same-id");
    expect(k2).not.toBe(podUrl);
    expect(podUrl).toContain("f_auto");
  });
});

describe("documents are gated on FORMAT, never on resource_type", () => {
  it("a PDF gets NEITHER parameter and keeps its .pdf extension", () => {
    // The trap: `resource_type: "auto"` stores a PDF as resource_type IMAGE,
    // format pdf. A gate written on resource_type would treat this as a photo.
    const url = pod.signedAssetUrl("uwc/documents/do-123", {
      resourceType: "image",
      format: "pdf",
      optimise: "quality",
    });
    expect(url).not.toContain("q_auto");
    expect(url).not.toContain("f_auto");
    expect(url.split(/[?#]/)[0]).toMatch(/\.pdf$/);
    expect(clientSeesAnImage(url), "a PDF must never be taken for an image").toBe(false);
  });

  it("a JPEG gets q_auto but NOT f_auto, and stays recognisable to the client", () => {
    const url = pod.signedAssetUrl("uwc/documents/invoice-9", {
      resourceType: "image",
      format: "jpg",
      optimise: "quality",
    });
    expect(url).toContain("q_auto");
    expect(url).not.toContain("f_auto");
    // The assertion that actually matters: the requestor app must still see an image.
    expect(
      clientSeesAnImage(url),
      "f_auto or a dropped extension would turn this document's thumbnail into a bare link"
    ).toBe(true);
  });

  it("an UNKNOWN format is left alone — the allowlist fails closed", () => {
    // A format nobody anticipated (a .dwg, a .heic variant, a future container)
    // must not be re-encoded on a guess.
    const url = pod.signedAssetUrl("uwc/documents/odd-1", {
      resourceType: "image",
      format: "dwg",
      optimise: "quality",
    });
    expect(url).not.toContain("q_auto");
    expect(url).not.toContain("f_auto");
  });

  it("an ABSENT format is left alone", () => {
    const url = pod.signedAssetUrl("uwc/documents/no-format", {
      resourceType: "image",
      optimise: "quality",
    });
    expect(url).not.toContain("q_auto");
    expect(url).not.toContain("f_auto");
  });

  it("a RAW asset is left alone whatever mode is asked for", () => {
    const url = pod.signedAssetUrl("uwc/documents/scan.tiff", {
      resourceType: "raw",
      optimise: "full",
    });
    expect(url).not.toContain("q_auto");
    expect(url).not.toContain("f_auto");
  });
});

describe("the default is untouched", () => {
  it("omitting `optimise` adds nothing — a new caller cannot acquire a transformation by accident", () => {
    const url = pod.signedAssetUrl("uwc/documents/invoice-9", {
      resourceType: "image",
      format: "jpg",
    });
    expect(url).not.toContain("q_auto");
    expect(url).not.toContain("f_auto");
  });
});

describe("the document serializer applies the safe mode", () => {
  it("signs a PDF document without optimising it", () => {
    const signed = pod.signTripResponse({
      stops: [],
      documents: [
        { id: "d1", public_id: "uwc/documents/do-123", resource_type: "image", format: "pdf", file_url: "stale" },
      ],
    }) as unknown as { documents: { file_url: string; public_id?: string }[] };

    const doc = signed.documents[0];
    expect(doc.file_url).not.toContain("f_auto");
    expect(doc.file_url).not.toContain("q_auto");
    // The identifier is still dropped — this module's original job.
    expect(doc.public_id).toBeUndefined();
  });

  it("optimises an image document and still drops the identifier", () => {
    const signed = pod.signTripResponse({
      stops: [],
      documents: [
        { id: "d2", public_id: "uwc/documents/inv-1", resource_type: "image", format: "png", file_url: "stale" },
      ],
    }) as unknown as { documents: { file_url: string; public_id?: string }[] };

    const doc = signed.documents[0];
    expect(doc.file_url).toContain("q_auto");
    expect(doc.file_url).not.toContain("f_auto");
    expect(doc.public_id).toBeUndefined();
  });

  it("optimises the POD fully but leaves the K2 alone — they are NOT interchangeable", () => {
    const signed = pod.signTripResponse({
      stops: [{ id: "s1", pod_public_id: "uwc/pod/T-1-stop-1", k2_public_id: "uwc/k2/T-1-stop-1-k2" }],
      documents: [],
    }) as unknown as { stops: { pod_photo: string; k2_photo: string; pod_public_id?: string }[] };

    const stop = signed.stops[0];
    // POD is images-only by server guard, so f_auto is safe.
    expect(stop.pod_photo).toContain("f_auto");
    // K2 may be a multi-page PDF. f_auto would deliver page one and drop the rest.
    expect(stop.k2_photo).not.toContain("f_auto");
    expect(stop.k2_photo).not.toContain("q_auto");
    expect(stop.pod_public_id).toBeUndefined();
  });
});
