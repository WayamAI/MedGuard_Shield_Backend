import type { AuthUser } from "../services/authService.js";
import type { TenantContext } from "../lib/tenant.js";

declare global {
  namespace Express {
    interface Request {
      /** Raw verified token claims. Populated by requireAuth. */
      user?: AuthUser;
      /**
       * Tenant context every service takes as its first argument. Populated by
       * requireAuth from the signed token — never from request input.
       */
      ctx?: TenantContext;
    }
  }
}

export {};
