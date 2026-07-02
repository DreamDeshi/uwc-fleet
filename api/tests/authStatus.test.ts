import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import { accountStatusError } from "../src/middleware/auth";

/**
 * Status gate applied on every authenticated request (requireAuth) and before
 * /auth/refresh mints new tokens: a valid JWT is not enough — the account must
 * still be `active`. Closes the audit hole where a disabled user kept full
 * access (and could refresh indefinitely) after being disabled.
 */
describe("accountStatusError", () => {
  it("lets an active account through", () => {
    expect(accountStatusError("active")).toBeNull();
  });

  it("rejects a disabled account with 401 ACCOUNT_DISABLED", () => {
    const err = accountStatusError("disabled");
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.statusCode).toBe(401);
    expect(err!.code).toBe("ACCOUNT_DISABLED");
  });

  it("rejects a pending_approval account", () => {
    const err = accountStatusError("pending_approval");
    expect(err?.code).toBe("ACCOUNT_DISABLED");
  });

  it("rejects when the user row no longer exists (undefined status)", () => {
    expect(accountStatusError(undefined)?.code).toBe("ACCOUNT_DISABLED");
    expect(accountStatusError(null)?.code).toBe("ACCOUNT_DISABLED");
  });
});
