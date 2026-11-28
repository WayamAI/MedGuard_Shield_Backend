import type { RequestHandler } from "express";
import { UnauthorizedError } from "../services/authService.js";
import { authenticateApiKey } from "../services/apiKeyService.js";

/**
 * Authenticates the ingestion API by its own credential, not a user session
 * — there is no browser involved, so there is no cookie and no access
 * token. `req.ctx` ends up populated the same way `requireAuth` populates
 * it, so every downstream service (which only ever takes a TenantContext)
 * works unmodified.
 */
export const requireApiKey: RequestHandler = (req, _res, next) => {
  const header = req.get("x-api-key");
  if (!header) {
    next(new UnauthorizedError("X-API-Key header required"));
    return;
  }
  authenticateApiKey(header)
    .then((ctx) => {
      req.ctx = ctx;
      next();
    })
    .catch(next);
};
