import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * COMPRESSION MUST NEVER BLOCK A CAPTURE.
 *
 * This is the one property the rest of the change rests on. A POD photo is the
 * gate on Delivered and therefore on pay, so an image library that misbehaves
 * has to cost bytes, never the delivery. Before this module the native path had
 * no try/catch at all: a manipulateAsync failure propagated straight out of
 * capturePodPhoto and killed the capture.
 *
 * The web twin gets the same treatment for a sharper reason — its predecessor
 * skipped compression entirely to fix a "photo picked but nothing happens" bug,
 * and a promise that rejects (or never settles) would look identical to a driver.
 */

const manipulateAsync = vi.fn();

vi.mock("expo-image-manipulator", () => ({
  manipulateAsync: (...args: unknown[]) => manipulateAsync(...args),
  SaveFormat: { JPEG: "jpeg" },
}));

vi.mock("expo-file-system", () => ({
  // Report a comfortably-under-limit file so the retry loop exits on pass one.
  File: class {
    size = 120 * 1024;
    constructor(public uri: string) {}
  },
}));

beforeEach(() => {
  manipulateAsync.mockReset();
});

describe("native compression", () => {
  it("returns the compressed uri on the happy path", async () => {
    manipulateAsync.mockResolvedValue({ uri: "file:///compressed.jpg" });
    const { compressToLimit } = await import("./imageCompress");

    expect(await compressToLimit("file:///original.heic")).toBe("file:///compressed.jpg");
  });

  it("FAILS OPEN — a throwing image library returns the ORIGINAL uri, not an error", async () => {
    manipulateAsync.mockRejectedValue(new Error("native module unavailable"));
    const { compressToLimit } = await import("./imageCompress");

    // The assertion is as much about not rejecting as about the value: an
    // unhandled rejection here is a driver standing at a dropoff unable to
    // record a delivery.
    await expect(compressToLimit("file:///original.jpg")).resolves.toBe("file:///original.jpg");
  });

  it("FAILS OPEN when the library resolves with nothing usable", async () => {
    manipulateAsync.mockResolvedValue(undefined);
    const { compressToLimit } = await import("./imageCompress");

    await expect(compressToLimit("file:///original.jpg")).resolves.toBe("file:///original.jpg");
  });
});

describe("web compression", () => {
  it("FAILS OPEN with no working canvas, rather than throwing", async () => {
    // Node has no `document`, which is the bluntest possible stand-in for "the
    // browser did not cooperate". The contract says: hand back the original.
    const { compressToLimit } = await import("./imageCompress.web");

    await expect(compressToLimit("blob:http://localhost/abc")).resolves.toBe(
      "blob:http://localhost/abc"
    );
  });
});
