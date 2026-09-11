import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/errors.js";

/** Anything that did not match a router. Registered after all routes. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "ROUTE_NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
};

/**
 * The single place an error becomes a response.
 *
 * Stack traces are logged server-side and never serialised into the body — an
 * API that fronts PHI should not narrate its internals to the caller.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Prisma's "record required but not found" — semantically a 404, not a 500.
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2025") {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Record not found" } });
    return;
  }

  console.error("[medguard] unhandled error:", err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};
