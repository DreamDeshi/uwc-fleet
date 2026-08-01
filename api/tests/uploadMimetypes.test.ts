import { describe, it, expect } from "vitest";
import { assertMimetype, IMAGE_MIMETYPES, DOCUMENT_MIMETYPES } from "../src/lib/upload";
import { ApiError } from "../src/lib/apiError";

/**
 * WHAT EACH ROUTE ACCEPTS IS A SERVER RULE NOW, NOT A CLIENT CONVENTION.
 *
 * It used to be true only because all four pickers were configured
 * `mediaTypes: ["images"]`. Two things came to depend on it:
 *
 *   1. The owner's ruling that a POD and exception evidence are proof something
 *      happened LIVE at the delivery point. POD gates pay.
 *   2. POD delivery URLs carry f_auto, which is safe only because a POD cannot
 *      be a PDF.
 *
 * A convention holding up two safety properties deserves to be a check.
 */

function reject(mimetype: string, allowed: readonly string[]) {
  return () => assertMimetype({ mimetype, originalname: "f" }, allowed, "A file");
}

describe("live-proof uploads accept images only", () => {
  it("accepts the formats a phone camera actually produces", () => {
    for (const m of ["image/jpeg", "image/png", "image/heic", "image/webp"]) {
      expect(reject(m, IMAGE_MIMETYPES)).not.toThrow();
    }
  });

  it("REJECTS a PDF — an arbitrary file must not stand in for a live photo", () => {
    expect(reject("application/pdf", IMAGE_MIMETYPES)).toThrow(ApiError);
    try {
      reject("application/pdf", IMAGE_MIMETYPES)();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(400);
      expect((e as ApiError).code).toBe("UNSUPPORTED_FILE_TYPE");
      // The message must say what IS wanted, not just what was refused.
      expect((e as ApiError).message).toMatch(/photo taken at the delivery point/i);
    }
  });

  it("rejects anything else, including things nobody thought of", () => {
    for (const m of ["application/zip", "text/html", "video/mp4", "application/octet-stream", ""]) {
      expect(reject(m, IMAGE_MIMETYPES)).toThrow(ApiError);
    }
  });
});

describe("paperwork accepts images AND pdf", () => {
  it("accepts a PDF — customs forms and invoices genuinely arrive as one", () => {
    expect(reject("application/pdf", DOCUMENT_MIMETYPES)).not.toThrow();
  });

  it("still accepts photos", () => {
    expect(reject("image/jpeg", DOCUMENT_MIMETYPES)).not.toThrow();
  });

  it("still rejects everything else", () => {
    for (const m of ["application/zip", "text/html", "application/msword"]) {
      expect(reject(m, DOCUMENT_MIMETYPES)).toThrow(ApiError);
    }
  });

  it("says a PDF is acceptable when it is", () => {
    try {
      reject("application/zip", DOCUMENT_MIMETYPES)();
    } catch (e) {
      expect((e as ApiError).message).toMatch(/photo or a PDF/i);
    }
  });
});

describe("the check is forgiving about form, strict about type", () => {
  it("tolerates casing and whitespace — a sloppy client is not an attacker", () => {
    expect(reject("IMAGE/JPEG", IMAGE_MIMETYPES)).not.toThrow();
    expect(reject("  image/png  ", IMAGE_MIMETYPES)).not.toThrow();
  });

  it("rejects a MISSING file object rather than waving it through", () => {
    expect(() => assertMimetype(undefined, IMAGE_MIMETYPES, "A file")).toThrow(ApiError);
    expect(() => assertMimetype({}, IMAGE_MIMETYPES, "A file")).toThrow(ApiError);
  });

  it("is an ALLOWLIST — a novel type fails closed", () => {
    // The failure mode of a denylist is that tomorrow's format walks through.
    expect(reject("image/jxl", IMAGE_MIMETYPES)).toThrow(ApiError);
    expect(reject("application/pdf+zip", DOCUMENT_MIMETYPES)).toThrow(ApiError);
  });
});
