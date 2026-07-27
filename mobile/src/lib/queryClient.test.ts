import { describe, expect, it } from "vitest";
import { retryPolicy } from "./queryClient";

const networkError = { isAxiosError: true }; // no response — transport failure
const serverError = { isAxiosError: true, response: { status: 500 } };

describe("retryPolicy", () => {
  it("retries transport failures up to 3 times", () => {
    expect(retryPolicy(0, networkError)).toBe(true);
    expect(retryPolicy(1, networkError)).toBe(true);
    expect(retryPolicy(2, networkError)).toBe(true);
    expect(retryPolicy(3, networkError)).toBe(false);
  });

  it("keeps a single retry for server responses", () => {
    expect(retryPolicy(0, serverError)).toBe(true);
    expect(retryPolicy(1, serverError)).toBe(false);
  });

  it("treats non-axios errors as non-transport (single retry)", () => {
    expect(retryPolicy(0, new Error("boom"))).toBe(true);
    expect(retryPolicy(1, new Error("boom"))).toBe(false);
  });
});
