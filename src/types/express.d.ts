import type { AuthUser } from "../services/authService.js";

// Lets route handlers read req.user without casting.
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
