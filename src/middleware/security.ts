import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";
import { isTest } from "../config.js";

/**
 * Rate limits.
 *
 * Two tiers, because the two risks are different. The global limit is there to
 * stop a runaway client or a crude scraper from flattening the API. The login
 * limit is much tighter and exists for one reason: bcrypt comparison is the
 * single most expensive operation in the system, which makes /api/auth/login
 * both the cheapest endpoint to abuse and the only one where guessing has a
 * prize.
 */

/** Errors go through the same envelope as every other failure. */
function limitResponse(_req: Request, res: Response) {
  res.status(429).json({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Try again shortly.",
    },
  });
}

/**
 * Generous ceiling for ordinary API traffic.
 *
 * A factory rather than a module-level singleton: rate-limit state lives in
 * the handler instance, so a shared one would make every app built in a
 * process -- notably every test -- draw from the same budget.
 */
export function createGlobalLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 1000 : 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
  });
}

/**
 * Login attempts. Counts only failures — `skipSuccessfulRequests` means a user
 * who keeps signing in legitimately is never locked out, while someone guessing
 * burns their budget quickly.
 */
export function createLoginLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 5 : 10,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
  });
}

/**
 * The ingestion API has no human in the loop to notice it misbehaving, so it
 * gets its own, tighter ceiling than ordinary browser traffic.
 */
export function createIngestLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 1000 : 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
  });
}

/**
 * Password reset and invite acceptance both consume a token an attacker
 * would otherwise be free to guess or brute-force without ever needing a
 * password. Tighter than the global limit, generous enough that a user who
 * fat-fingers their new password twice never notices it's there.
 */
export function createSensitiveAuthLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 1000 : 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
  });
}

/**
 * Exports can pull an entire organization's estate in one request; nothing
 * stops a compromised session from calling every export endpoint in a tight
 * loop, so each gets its own ceiling independent of ordinary read traffic.
 */
export function createExportLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 1000 : 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
    // The limiter is mounted on ordinary list routes that only sometimes
    // export (`?format=csv`); skipping everything else means an export
    // ceiling never counts against normal paginated reads on the same path.
    skip: (req) => req.query.format !== "csv",
  });
}
