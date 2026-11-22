import type { RequestHandler } from "express";
import { HttpError } from "../lib/errors.js";

/**
 * CSRF protection for the two endpoints authenticated purely by a cookie the
 * browser attaches automatically: `/auth/refresh` and `/auth/logout`. Every
 * other mutating route also requires a bearer access token in a header,
 * which a cross-site form POST cannot supply — these two are the exception,
 * since a refresh/logout should work even once the access token has expired.
 *
 * The defense: require a custom request header. A plain HTML `<form>` POST
 * (the classic CSRF vector) cannot set custom headers at all, and a
 * cross-origin `fetch`/XHR that tries to forces a CORS preflight, which
 * `cors()` in app.ts already rejects for any origin outside
 * `FRONTEND_ORIGIN` — so this header requirement is only satisfiable by a
 * same-origin request or a CORS-approved one, never a forged cross-site
 * form submission.
 */
const CSRF_HEADER = "x-drishti-csrf";

export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (!req.get(CSRF_HEADER)) {
    next(new HttpError(403, "Missing required CSRF header", "CSRF_HEADER_REQUIRED"));
    return;
  }
  next();
};
