import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "../generated/prisma/client.js";
import { HttpError } from "../lib/errors.js";
import { UnauthorizedError, verifyToken } from "../services/authService.js";

/**
 * Accepts the token from an Authorization: Bearer header, falling back to a
 * `medguard_token` cookie so a browser client can work either way.
 */
function extractToken(req: Request): string | null {
  const header = req.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || null;
  }

  const cookie = req.get("cookie");
  const match = cookie?.match(/(?:^|;\s*)medguard_token=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Rejects anything without a valid session and attaches req.user. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError("Authentication required");
    req.user = verifyToken(token);
    next();
  } catch (err) {
    next(err);
  }
};

class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message, "FORBIDDEN");
  }
}

/**
 * Role gate, for routes that later need to be narrower than "any logged-in
 * user" — e.g. requireRole(["ADMIN", "ANALYST"]) on a future write endpoint.
 * Always mount it after requireAuth.
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
