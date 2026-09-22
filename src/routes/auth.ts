import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import {
  ACCESS_COOKIE, LEGACY_ACCESS_COOKIE, REFRESH_COOKIE,
  ctxOf, extractRefreshToken, requireAuth,
} from "../middleware/auth.js";
import { ok } from "../lib/http.js";
import { recordAuthEvent, recordAuthEventSafe } from "../services/auditService.js";
import {
  ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS,
  login, refreshSession, revokeAllRefreshTokens, revokeRefreshToken,
  type SessionResult,
} from "../services/authService.js";
import { prisma } from "../lib/prisma.js";

export const authRouter = Router();

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
  /** Optional: sign in under a specific membership. Defaults to the first. */
  organizationId: z.coerce.number().int().positive().optional(),
});

/**
 * Cookies are the preferred transport for the browser client, which
 * deliberately does not put tokens in localStorage.
 *
 * `secure` is on unless we are explicitly in development. It is derived from
 * NODE_ENV rather than hardcoded off, so a production deploy is secure by
 * default and the plain-http local setup still works.
 *
 * `sameSite` is "lax" in development (API and app share localhost) and "none"
 * in production, where they sit on different domains -- and "none" requires
 * "secure", which is exactly what the line above provides.
 */
function cookieOptions(maxAgeSeconds: number) {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ("none" as const) : ("lax" as const),
    maxAge: maxAgeSeconds * 1000,
    path: "/",
  };
}

function setSessionCookies(res: Parameters<typeof ok>[0], session: SessionResult): void {
  res.cookie?.(ACCESS_COOKIE, session.token, cookieOptions(ACCESS_TOKEN_TTL_SECONDS));
  res.cookie?.(REFRESH_COOKIE, session.refreshToken, cookieOptions(REFRESH_TOKEN_TTL_SECONDS));
}

/**
 * The refresh token is returned in the body as well as the cookie so a
 * non-browser client (CLI, mobile, the test suite) can hold it. Browser
 * clients should ignore it and let the cookie do the work.
 */
function sessionBody(session: SessionResult) {
  return {
    token: session.token,
    expiresIn: session.expiresIn,
    refreshToken: session.refreshToken,
    refreshExpiresIn: session.refreshExpiresIn,
    user: session.user,
    memberships: session.memberships,
  };
}

authRouter.post("/login", validate({ body: loginBody }), async (req, res, next) => {
  const { email, password, organizationId } = loginBody.parse(req.body);
  try {
    const session = await login(email, password, {
      organizationId,
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });

    setSessionCookies(res, session);

    await recordAuthEvent({
      action: "LOGIN",
      actorEmail: session.user.email,
      actorUserId: session.user.id,
      organizationId: session.user.organizationId,
      req,
    });

    ok(res, sessionBody(session));
  } catch (err) {
    // Recorded even though the request fails -- a failed login is exactly the
    // event a security review asks for. Best-effort so an audit outage cannot
    // turn a rejected login into a 500 that leaks whether the guess was close.
    await recordAuthEventSafe({
      action: "LOGIN_FAILED",
      actorEmail: email,
      result: "FAILURE",
      req,
    });
    next(err);
  }
});

/**
 * Rotates the session. The old refresh token is revoked as part of the
 * exchange; presenting it again revokes every session for that user, because
 * a replayed refresh token means the chain is compromised.
 */
authRouter.post("/refresh", async (req, res, next) => {
  try {
    const presented = extractRefreshToken(req);
    if (!presented) {
      ok(res, null, 401);
      return;
    }

    const session = await refreshSession(presented, {
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });

    setSessionCookies(res, session);

    await recordAuthEvent({
      action: "TOKEN_REFRESHED",
      actorEmail: session.user.email,
      actorUserId: session.user.id,
      organizationId: session.user.organizationId,
      req,
    });

    ok(res, sessionBody(session));
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const presented = extractRefreshToken(req);
    if (presented) await revokeRefreshToken(presented);

    res.clearCookie?.(ACCESS_COOKIE, { path: "/" });
    res.clearCookie?.(REFRESH_COOKIE, { path: "/" });
    res.clearCookie?.(LEGACY_ACCESS_COOKIE, { path: "/" });

    // req.user is only present when a valid access token accompanied the
    // logout; a logout with an already-expired token is still a logout.
    if (req.user) {
      await recordAuthEvent({
        action: "LOGOUT",
        actorEmail: req.user.email,
        actorUserId: req.user.id,
        organizationId: req.user.organizationId,
        req,
      });
    }

    ok(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

/** Sign out everywhere: revokes every live refresh token for the account. */
authRouter.post("/logout-all", requireAuth, async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const revoked = await revokeAllRefreshTokens(ctx.userId);

    res.clearCookie?.(ACCESS_COOKIE, { path: "/" });
    res.clearCookie?.(REFRESH_COOKIE, { path: "/" });

    await recordAuthEvent({
      action: "TOKEN_REVOKED",
      actorEmail: ctx.email,
      actorUserId: ctx.userId,
      organizationId: ctx.organizationId,
      metadata: { revokedSessions: revoked },
      req,
    });

    ok(res, { ok: true, revokedSessions: revoked });
  } catch (err) {
    next(err);
  }
});

/** Current session, including the organisation it is scoped to. */
authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const [organization, memberships] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: ctx.organizationId },
        select: { id: true, name: true, slug: true },
      }),
      prisma.organizationMember.findMany({
        where: { userId: ctx.userId },
        include: { organization: { select: { name: true, slug: true } } },
        orderBy: { organizationId: "asc" },
      }),
    ]);

    ok(res, {
      id: ctx.userId,
      email: ctx.email,
      role: ctx.role,
      organizationId: ctx.organizationId,
      organization,
      memberships: memberships.map((m) => ({
        organizationId: m.organizationId,
        organizationName: m.organization.name,
        organizationSlug: m.organization.slug,
        role: m.role,
      })),
    });
  } catch (err) {
    next(err);
  }
});
