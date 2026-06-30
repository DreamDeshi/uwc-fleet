import type { ErrorRequestHandler } from "express";
import { MulterError } from "multer";
import { ApiError } from "../lib/apiError";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
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

  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
};
