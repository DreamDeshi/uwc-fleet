import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { ApiError } from "../lib/apiError";

// Server-side role gate, always layered AFTER requireAuth (which sets
// req.user). Every route declares the roles it accepts — the clients hide
// buttons for UX, but this is the check that actually enforces it.
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // 403 (not 401) on a role mismatch: we know who you are, you're just not
    // allowed to do this — the client shouldn't drop the session over it.
    if (!req.user || !allowed.includes(req.user.role)) {
      next(new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action."));
      return;
    }
    next();
  };
}
