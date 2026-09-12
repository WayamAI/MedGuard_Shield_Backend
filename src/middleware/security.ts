import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";

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

const isTest = process.env.NODE_ENV === "test";

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
