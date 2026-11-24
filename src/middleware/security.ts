import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";
import { isTest } from "../config.js";
import type { TenantContext } from "../lib/tenant.js";

/**
 * Rate limits.
 *
 * Keyed on *who*, not *where from*, for every authenticated route — see
 * createAuthenticatedLimiter below for why an IP-keyed ceiling is actively
 * wrong there. IP-based limits are reserved for the handful of routes that
 * run before anyone is known to be anyone: login, forgot-password,
 * reset-password, accept-invite (MFA verification is the second call to
 * /api/auth/login with mfaCode, so it's covered by the same login limiter —
 * there is no separate MFA-verify route). The login limit is tighter than
 * the others because bcrypt comparison is the single most expensive
 * operation in the system, which makes it both the cheapest endpoint to
 * abuse and the only one where guessing has a prize.
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
 * Backstop for the small, low-volume slice of /api/auth that isn't already
 * covered by a tighter per-route limiter: the requireAuth-gated control-plane
 * calls (/me, /mfa/*, /sessions, /change-password, /logout-all). These are
 * authenticated but not part of the polling surface (see
 * createAuthenticatedLimiter) — a user hits them a handful of times per
 * session, never every 30 seconds — so IP-keying them is a reasonable
 * simplification rather than plumbing user-keying through authRouter's
 * mixed public/protected routes. Scoped to "/api/auth" only; nothing else
 * mounts this any more.
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
 * The real fix for the shared-NAT problem: every route mounted after
 * `app.use("/api", requireAuth)` — the entire dashboard/CRUD surface a
 * hospital's whole staff polls continuously — is keyed on the caller's user
 * id, not their IP. A hospital where every workstation shares one outbound
 * IP now gets one budget *per logged-in person*, not one budget for the
 * whole building.
 *
 * Ceiling, worked from the frontend's actual polling pattern: it refreshes
 * on a 30-second interval, and a busy dashboard view fires up to 6 distinct
 * queries per tick (risk distribution, assets list, threats summary,
 * remediations summary, notifications unread-count, access summary). Over
 * this limiter's 15-minute (900s) window that's 900/30 = 30 polling cycles,
 * x 6 queries = 180 requests from passive polling alone — the steady-state
 * floor this ceiling must clear with room to spare, since the window resets
 * every 15 minutes forever, so clearing one window's steady state means
 * clearing every window for as long as the person is logged in, a full
 * working day included. 600 gives roughly 3x headroom over that floor for
 * simultaneous manual use (paging, filtering, opening detail views) on top
 * of the background polling.
 */
export function createAuthenticatedLimiter(options: { limit?: number } = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: options.limit ?? (isTest ? 10_000 : 600),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
    keyGenerator: (req) => {
      const ctx = req.ctx as TenantContext | undefined;
      return ctx ? `user:${ctx.userId}` : ipKeyGenerator(req.ip ?? "unknown");
    },
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
 * gets its own, tighter ceiling than ordinary browser traffic. Keyed on the
 * API key's own id (not the IP, not the creating user) — must be mounted
 * after requireApiKey so req.ctx.connectorId exists. Two keys calling from
 * the same server (the common case: a hospital's one integration box) each
 * get an independent budget, which an IP key would not have given them.
 */
export function createIngestLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 1000 : 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
    keyGenerator: (req) => {
      const ctx = req.ctx as (TenantContext & { connectorId?: number }) | undefined;
      return ctx?.connectorId !== undefined ? `apikey:${ctx.connectorId}` : ipKeyGenerator(req.ip ?? "unknown");
    },
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
 * Keyed on the caller's user id for the same shared-NAT reason as
 * createAuthenticatedLimiter — must be mounted after requireAuth.
 */
export function createExportLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 1000 : 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitResponse,
    keyGenerator: (req) => {
      const ctx = req.ctx as TenantContext | undefined;
      return ctx ? `user:${ctx.userId}` : ipKeyGenerator(req.ip ?? "unknown");
    },
    // The limiter is mounted on ordinary list routes that only sometimes
    // export (`?format=csv`); skipping everything else means an export
    // ceiling never counts against normal paginated reads on the same path.
    skip: (req) => req.query.format !== "csv",
  });
}
