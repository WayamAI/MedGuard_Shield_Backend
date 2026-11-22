import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Options } from "pino-http";
import { env, isProduction } from "../config.js";

// pino-http ships as CJS with a `.d.ts` default export that NodeNext module
// resolution cannot synthesize cleanly (its import yields the namespace
// type, not a callable) — require() sidesteps that mismatch; the type
// import above keeps the options object checked.
const pinoHttp = createRequire(import.meta.url)("pino-http") as (opts: Options) => import("pino-http").HttpLogger;

/**
 * One request-ID header name, shared with errorHandler.ts's error envelope
 * (`error.requestId`) so a support ticket can be traced from the client
 * response straight to the matching log line.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Patterns matched against log keys (case-insensitive). Anything that
 * matches is replaced with "[Redacted]" rather than logged — tokens,
 * passwords, cookies, and patient-identifier-shaped fields (SSN, MRN, DOB)
 * that should never reach application logs per the PHI-metadata-only
 * invariant.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers[\"set-cookie\"]",
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.ssn',
  '*.mrn',
  '*.dob',
  '*.dateOfBirth',
];

export const httpLogger = pinoHttp({
  level: env.NODE_ENV === "test" ? "silent" : isProduction ? "info" : "debug",
  redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
  genReqId: (req, res) => {
    const existing = req.headers[REQUEST_ID_HEADER];
    const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
    res.setHeader(REQUEST_ID_HEADER, id);
    return id;
  },
});
