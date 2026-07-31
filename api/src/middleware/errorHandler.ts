import type { ErrorRequestHandler } from "express";
import { MulterError } from "multer";
import { ApiError } from "../lib/apiError";
import { captureServerError } from "../lib/sentry";

/**
 * ⚠ THE RESPONSE IS UNCHANGED BY MONITORING.
 *
 * Every branch below returns exactly what it returned before Sentry existed —
 * same status, same code, same message. Reporting happens ALONGSIDE the reply,
 * never instead of it and never in front of it, and captureServerError swallows
 * its own failures so a monitoring outage cannot turn a handled 500 into an
 * unhandled one.
 *
 * ONLY UNEXPECTED ERRORS ARE REPORTED. An ApiError is the API working as
 * designed — a 400 for bad input, a 403 for the wrong role, a 409 for a lost
 * race — and shipping those would bury the signal under the ordinary traffic of
 * a working system. A 5xx ApiError IS reported: we raised it deliberately, but
 * it still means the server failed.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ApiError) {
    // Deliberate 5xx still counts as a server failure worth knowing about.
    if (err.statusCode >= 500) captureServerError(err, req);
    res
      .status(err.statusCode)
      .json({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
    return;
  }

  // Multer rejects oversized/invalid uploads — surface as a clean 400.
  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 10MB)." : "File upload failed.";
    res.status(400).json({ error: { code: err.code, message } });
    return;
  }

  // The unexpected ones — the whole reason this exists. console.error stays:
  // Railway's logs remain the record of last resort if Sentry is unconfigured
  // or unreachable.
  console.error(err);
  captureServerError(err, req);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
};
