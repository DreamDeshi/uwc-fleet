import { describe, it, expect } from "vitest";
import { isCompressibleType, asJpgName } from "./uploadTypes";

/**
 * A PDF MUST NOT BE RE-ENCODED.
 *
 * This is the client-side half of the multi-page guarantee. The server refuses
 * to format-convert a K2 on delivery (lib/podPhotos.ts, signedK2Url); this rule
 * stops the app mangling a document on the way IN, where no server gate could
 * recover it. Re-encoding a PDF is how pages get dropped, and paperwork —
 * customs forms, invoices — is exactly the class of file that runs to several.
 */

describe("only images may be re-encoded", () => {
  it("compresses the image types a picker can produce", () => {
    for (const t of ["image/jpeg", "image/png", "image/heic", "image/webp", "image/gif"]) {
      expect(isCompressibleType(t), t).toBe(true);
    }
  });

  it("NEVER compresses a PDF", () => {
    expect(isCompressibleType("application/pdf")).toBe(false);
    expect(isCompressibleType("APPLICATION/PDF")).toBe(false);
    expect(isCompressibleType("  application/pdf  ")).toBe(false);
  });

  it("leaves an unknown or missing type alone rather than guessing", () => {
    // Guessing "image" here would relabel the file image/jpeg and hand it to a
    // re-encoder — the failure this whole rule exists to prevent.
    for (const t of ["", "  ", "application/octet-stream", undefined, null]) {
      expect(isCompressibleType(t as string | undefined)).toBe(false);
    }
  });

  it("is not fooled by a type that merely mentions an image", () => {
    expect(isCompressibleType("application/pdf; image")).toBe(false);
    expect(isCompressibleType("multipart/form-data")).toBe(false);
  });
});

describe("a re-encoded file is renamed to match", () => {
  it("swaps the extension, because Cloudinary records the format from the name", () => {
    expect(asJpgName("scan.png")).toBe("scan.jpg");
    expect(asJpgName("invoice.HEIC")).toBe("invoice.jpg");
  });

  it("replaces only the FINAL extension, keeping dots inside the stem", () => {
    // Office filenames are full of dots. Stripping to the first one would turn
    // "DO.2026.08.01.png" into "DO.jpg" and lose which document it was.
    expect(asJpgName("DO.2026.08.01.png")).toBe("DO.2026.08.01.jpg");
  });

  it("handles a name with no extension, and a name that is nothing but one", () => {
    expect(asJpgName("photo")).toBe("photo.jpg");
    expect(asJpgName(".png")).toBe("document.jpg");
    expect(asJpgName("")).toBe("document.jpg");
  });
});
