import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "../generated/prisma/client.js";
import { ForbiddenError, UnauthorizedError, contextFor, verifyToken } from "../services/authService.js";
import type { TenantContext } from "../lib/tenant.js";
import { can, rolesWith, type Permission } from "../lib/permissions.js";

/** Current access-token cookie. */
export const ACCESS_COOKIE = "drishti_token";
/** Current refresh-token cookie. */
export const REFRESH_COOKIE = "drishti_refresh";
/**
 * Pre-rename cookie, still accepted on the way in so a browser holding a
 * MedGuard-era session is not silently logged out by the rebrand. Never set
 * any more — `POST /api/auth/login` issues only the current names, and logout
 * clears both. Remove once no live session can predate the rename.
 */
export const LEGACY_ACCESS_COOKIE = "medguard_token";

/** Reads one cookie out of the raw header. No cookie-parser dependency. */
function cookieValue(req: Request, name: string): string | null {
  const header = req.get("cookie");
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Accepts the access token from an Authorization: Bearer header, falling back
 * to a cookie so a browser client can work either way.
 */
function extractToken(req: Request): string | null {
  const header = req.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || null;
  }

  return cookieValue(req, ACCESS_COOKIE) ?? cookieValue(req, LEGACY_ACCESS_COOKIE);
}

/** The refresh token, which lives only in its httpOnly cookie or the body. */
export function extractRefreshToken(req: Request): string | null {
  const fromCookie = cookieValue(req, REFRESH_COOKIE);
  if (fromCookie) return fromCookie;

  // Body fallback for non-browser clients that cannot hold cookies.
  const body = req.body as { refreshToken?: unknown } | undefined;
  return typeof body?.refreshToken === "string" && body.refreshToken.length > 0
    ? body.refreshToken
    : null;
}

/**
 * Rejects anything without a valid session, and attaches both the raw claims
 * (`req.user`) and the tenant context every service takes (`req.ctx`).
 *
 * `req.ctx.organizationId` originates here, from the signed token — it is
 * never read from a path, query or body anywhere in the codebase. That is the
 * whole tenant boundary.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError("Authentication required");
    const user = verifyToken(token);
    req.user = user;
    req.ctx = contextFor(user);
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Permission gate. Always mount it after requireAuth, which populates req.user.
 *
 * Prefer this over `requireRole`: the permission names the operation, so the
 * matrix in lib/permissions.ts stays the single answer to "what can an analyst
 * do?" rather than something reconstructed by grepping route files.
 *
 * The role consulted is the caller's role *in the organisation the token
 * names*, so the same account can be ADMIN in one tenant and VIEWER in
 * another.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }
    if (!can(req.user.role, permission)) {
      next(
        new ForbiddenError(
          `Requires one of: ${rolesWith(permission).join(", ")} (permission: ${permission})`,
        ),
      );
      return;
    }
    next();
  };
}

/**
 * Raw role gate. Retained for the two places a permission would be a worse
 * fit than a role, and for tests that assert on role semantics directly.
 */
export function requireRole(roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError(`Requires one of: ${roles.join(", ")}`));
      return;
    }
    next();
  };
}

/**
 * The tenant context for a request that has passed `requireAuth`.
 *
 * Throws rather than returning undefined: a handler reaching this without a
 * context is a routing mistake (the gate was not mounted), and failing closed
 * is the only safe response to "I do not know whose data this is".
 */
export function ctxOf(req: Request): TenantContext {
  if (!req.ctx) throw new UnauthorizedError("Authentication required");
  return req.ctx;
}
