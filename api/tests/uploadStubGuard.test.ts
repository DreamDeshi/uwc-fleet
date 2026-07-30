import { describe, it, expect, afterEach } from "vitest";
import { uploadStubEnabled } from "../src/lib/cloudinary";

/**
 * The upload stub exists so the CI browser suite can exercise POD and exception
 * evidence without Cloudinary credentials. Its ONLY real risk is being on where
 * it should not be: if uploads were faked in production, PODs would silently
 * stop being stored — and a POD is the evidence a payment dispute turns on. The
 * failure would be invisible until someone went looking for a photo that never
 * existed.
 *
 * So the guard is what gets tested, not the stub.
 */
const original = { flag: process.env.E2E_STUB_UPLOADS, env: process.env.NODE_ENV };

afterEach(() => {
  if (original.flag === undefined) delete process.env.E2E_STUB_UPLOADS;
  else process.env.E2E_STUB_UPLOADS = original.flag;
  if (original.env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.env;
});

describe("upload stub guard", () => {
  it("is OFF by default", () => {
    delete process.env.E2E_STUB_UPLOADS;
    process.env.NODE_ENV = "development";
    expect(uploadStubEnabled()).toBe(false);
  });

  it("is REFUSED in production even when the flag is set", () => {
    process.env.E2E_STUB_UPLOADS = "true";
    process.env.NODE_ENV = "production";
    expect(uploadStubEnabled()).toBe(false);
  });

  it("is on only for the exact string 'true' in a non-production environment", () => {
    process.env.NODE_ENV = "test";
    for (const value of ["true"]) {
      process.env.E2E_STUB_UPLOADS = value;
      expect(uploadStubEnabled(), `expected ${value} to enable`).toBe(true);
    }
    // Anything else is off — a truthy-looking value must not enable faked
    // uploads, the same discipline the feature flags use.
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      process.env.E2E_STUB_UPLOADS = value;
      expect(uploadStubEnabled(), `expected ${JSON.stringify(value)} NOT to enable`).toBe(false);
    }
  });
});
