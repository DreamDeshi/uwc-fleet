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

  // ⚠ TWO SITUATIONS, TWO MESSAGES. This used to answer ACCOUNT_DISABLED for a
  // pending account too, so a new driver waiting to be approved and an employee
  // disabled by mistake read the identical sentence and neither learned who to
  // ask. Still 401 either way — the client must drop its tokens in both cases.
  it("tells a pending_approval account it is waiting, not disabled", () => {
    const err = accountStatusError("pending_approval");
    expect(err!.statusCode).toBe(401);
    expect(err!.code).toBe("ACCOUNT_PENDING_APPROVAL");
    expect(err!.message).toMatch(/waiting for admin approval/i);
  });

  it("names the remedy in both messages", () => {
    // The point of the copy pass: an error that states the rule and stops is a
    // dead end. Each of these has to say who can fix it.
    expect(accountStatusError("disabled")!.message).toMatch(/contact the office/i);
    expect(accountStatusError("pending_approval")!.message).toMatch(/ask the office/i);
  });

  it("treats a vanished user row as disabled, not as pending", () => {
    // An unknown status must fall to the CLOSED end of the two, never to the
    // "just wait and it will be approved" one.
    expect(accountStatusError(undefined)?.code).toBe("ACCOUNT_DISABLED");
    expect(accountStatusError(null)?.code).toBe("ACCOUNT_DISABLED");
    expect(accountStatusError("some_future_status")?.code).toBe("ACCOUNT_DISABLED");
  });
});
