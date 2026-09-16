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
/**
 * Errors thrown by body-parser before any route runs. They already carry the
 * status they deserve, and a `body` field holding the raw payload.
 */
type BodyParserError = { type: string; statusCode?: number };

const BODY_PARSER_FAILURES: Record<string, { status: number; code: string; message: string }> = {
  "entity.parse.failed": {
    status: 400, code: "MALFORMED_JSON", message: "Request body is not valid JSON",
  },
  "entity.too.large": {
    status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large",
  },
  "encoding.unsupported": {
    status: 415, code: "UNSUPPORTED_ENCODING", message: "Unsupported content encoding",
  },
  "entity.verify.failed": {
    status: 400, code: "MALFORMED_JSON", message: "Request body could not be verified",
  },
};

function bodyParserFailure(err: unknown) {
  if (typeof err !== "object" || err === null) return null;
  const type = (err as BodyParserError).type;
  return typeof type === "string" ? BODY_PARSER_FAILURES[type] ?? null : null;
}

/**
 * Defence in depth for the catch-all log below. Framework errors sometimes
 * carry the raw request payload on `body` — body-parser is the known case and
 * is handled above, but nothing that reaches the generic branch should print a
 * payload either, because for a login that payload is a plaintext password.
 *
 * Returns the error untouched when there is no `body` to strip, so ordinary
 * errors keep their usual formatting and stack.
 */
function withoutRawBody(err: unknown): unknown {
  if (typeof err !== "object" || err === null || !("body" in err)) return err;
  const { body: _raw, ...rest } = err as Record<string, unknown>;
  const asError = err as unknown as Partial<Error>;
  return { ...rest, body: "[redacted]", message: asError.message, stack: asError.stack };
}

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

  // An unreadable body is the client's mistake, not ours. body-parser sets the
  // right status on the error; surfacing it as a 500 makes a fat-fingered
  // request look like the server fell over.
  //
  // The raw payload rides along on err.body -- for a malformed login that is a
  // password in plaintext -- so it is neither echoed to the caller nor written
  // to the log. Only the failure type and status are recorded.
  const parseFailure = bodyParserFailure(err);
  if (parseFailure) {
    console.error(
      `[medguard] rejected unreadable request body: ${(err as BodyParserError).type} -> ${parseFailure.status}`,
    );
    res.status(parseFailure.status).json({
      error: { code: parseFailure.code, message: parseFailure.message },
    });
    return;
  }

  // Prisma's "record required but not found" — semantically a 404, not a 500.
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2025") {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Record not found" } });
    return;
  }

  console.error("[medguard] unhandled error:", withoutRawBody(err));
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};
