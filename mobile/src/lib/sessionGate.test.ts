import { describe, it, expect } from "vitest";
import { isConnectivityError, bootstrapActionForError } from "./sessionGate";

// Fakes shaped like the axios errors AuthContext's bootstrap actually catches.
const networkError = { isAxiosError: true, message: "Network Error" }; // no `response`
const timeoutError = { isAxiosError: true, code: "ECONNABORTED" }; // no `response`
const unauthorized = { isAxiosError: true, response: { status: 401 } };
const serverError = { isAxiosError: true, response: { status: 500 } };
const nonAxios = new Error("boom");

describe("sessionGate — keep the session offline, clear it only on a real rejection", () => {
  it("treats a no-response axios error as connectivity (offline/timeout)", () => {
    expect(isConnectivityError(networkError)).toBe(true);
    expect(isConnectivityError(timeoutError)).toBe(true);
  });

  it("treats any HTTP response (401/500) as NOT connectivity", () => {
    expect(isConnectivityError(unauthorized)).toBe(false);
    expect(isConnectivityError(serverError)).toBe(false);
  });

  it("treats a non-axios throw as NOT connectivity", () => {
    expect(isConnectivityError(nonAxios)).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
    expect(isConnectivityError(undefined)).toBe(false);
  });

  it("KEEPS the session on a network error — the offline cold-start fix", () => {
    expect(bootstrapActionForError(networkError)).toBe("keep");
    expect(bootstrapActionForError(timeoutError)).toBe("keep");
  });

  it("CLEARS the session on a genuine 401 — real auth expiry is untouched", () => {
    expect(bootstrapActionForError(unauthorized)).toBe("clear");
  });

  it("CLEARS on any other server response or unknown error (fail safe to login)", () => {
    expect(bootstrapActionForError(serverError)).toBe("clear");
    expect(bootstrapActionForError(nonAxios)).toBe("clear");
  });
});
