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
  if (status !== "active") {
    return new ApiError(
      401,
      "ACCOUNT_DISABLED",
      "This account is disabled or awaiting approval."
    );
  }
  return null;
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
    payload = verifyAccessToken(token);
  } catch {
    next(new ApiError(401, "INVALID_TOKEN", "Access token is invalid or expired."));
    return;
  }

  try {
    // Account status is re-checked on EVERY request (single indexed PK lookup)
    // so that disabling a user cuts access immediately — otherwise a disabled
    // account could keep authenticating until its tokens expire (30-min access,
    // and /refresh would mint new ones for 7-day stretches).
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true },
    });
    const statusErr = accountStatusError(user?.status);
    if (statusErr) {
      next(statusErr);
      return;
    }
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    next(err);
  }
}
