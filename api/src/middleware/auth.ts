import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/apiError";
import { verifyAccessToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

/**
 * Maps an account status to the auth error it should produce, or null when the
 * account may proceed. A valid JWT alone is NOT enough: only `active` accounts
 * pass — anything else (disabled, pending_approval, or a deleted row) is
 * rejected. 401 (not 403) so clients treat it as a dead session and drop their
 * tokens. Exported for unit tests.
 */
export function accountStatusError(status: string | null | undefined): ApiError | null {
  if (status === "active") return null;
  // ⚠ TWO SITUATIONS, TWO MESSAGES, AND BOTH NAME THE REMEDY. This returned one
  // sentence — "This account is disabled or awaiting approval." — for every
  // non-active status, so a new driver waiting to be approved and an employee
  // disabled by mistake read the same words and neither learned who to ask.
  // The login route already distinguished them; this path is what every request
  // AFTER login hits, so an account disabled mid-shift got the vaguer one.
  if (status === "pending_approval") {
    return new ApiError(
      401,
      "ACCOUNT_PENDING_APPROVAL",
      "Your account is still waiting for admin approval. Ask the office to approve it."
    );
  }
  return new ApiError(
    401,
    "ACCOUNT_DISABLED",
    "This account has been disabled. Contact the office if this is a mistake."
  );
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(new ApiError(401, "UNAUTHORIZED", "Missing or malformed Authorization header."));
    return;
  }

  const token = header.slice("Bearer ".length);
  let payload;
  try {
    // Step 1: cryptographic check — signature + expiry. This proves who the
    // token SAYS you are, but deliberately isn't the whole story (step 2 below).
    payload = verifyAccessToken(token);
  } catch {
    next(new ApiError(401, "INVALID_TOKEN", "Access token is invalid or expired."));
    return;
  }

  try {
    // Step 2: is this account still allowed in, and with what role RIGHT NOW?
    // Both status and role are re-checked on EVERY request (still a single
    // indexed PK lookup — same round trip as before, one more column) so that
    // disabling OR DEMOTING a user cuts that privilege immediately, not just
    // on next login — otherwise a demoted admin's already-issued access token
    // keeps passing requireRole("admin") until it naturally expires (30-min
    // access, and /refresh would mint new ones for 7-day stretches). Trusting
    // `payload.role` from the token, as this used to, meant a demotion during
    // incident response did not actually revoke the demoted admin's access
    // until the token expired on its own — found in code review 31 Aug 2026,
    // the same shape as the status check right above it, just for the field
    // that check's own comment didn't cover.
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, role: true },
    });
    const statusErr = accountStatusError(user?.status);
    if (statusErr) {
      next(statusErr);
      return;
    }
    // Attach the identity for downstream handlers — requireRole and the
    // row-level ownership checks all read req.user from here. `role` is the
    // DB's CURRENT value, not the token's snapshot from login time.
    req.user = { id: payload.sub, role: user!.role };
    next();
  } catch (err) {
    next(err);
  }
}
