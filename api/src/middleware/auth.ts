import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/apiError";
import { verifyAccessToken } from "../lib/jwt";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(new ApiError(401, "UNAUTHORIZED", "Missing or malformed Authorization header."));
    return;
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new ApiError(401, "INVALID_TOKEN", "Access token is invalid or expired."));
  }
}
