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
  REFRESH_TOKEN_TTL_SECONDS,
  login, MfaRequiredError, refreshSession, revokeAllRefreshTokens, revokeRefreshToken,
  type SessionResult,
} from "../services/authService.js";
import { prisma } from "../lib/prisma.js";
import { isProduction } from "../config.js";
import { requireCsrfHeader } from "../middleware/csrf.js";
import { createSensitiveAuthLimiter } from "../middleware/security.js";
import { hashRefreshToken, listSessions, revokeOtherSessions, revokeSessionById } from "../services/authService.js";
import { changePassword, requestPasswordReset, resetPassword } from "../services/passwordResetService.js";
import { acceptInvite } from "../services/memberService.js";
import { confirmMfaEnrollment, disableMfa, startMfaEnrollment } from "../services/mfaService.js";
import { recordAudit } from "../services/auditService.js";

export const authRouter = Router();

export const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
  /** Optional: sign in under a specific membership. Defaults to the first. */
  organizationId: z.coerce.number().int().positive().optional(),
  /** Required on the second call when the first returned MFA_REQUIRED. */
  mfaCode: z.string().trim().min(1).optional(),
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
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? ("none" as const) : ("lax" as const),
    maxAge: maxAgeSeconds * 1000,
    path: "/",
  };
}

/**
 * Only the refresh credential is ever a cookie. The access token is returned
 * in the response body only (see sessionBody below) and must live in memory
 * on the client — a cookie-borne access token would be sent automatically on
 * every cross-site request, and unlike refresh/logout there is no practical
 * way to require a custom CSRF header on every one of the ~50 other mutating
 * routes. See middleware/auth.ts's extractToken for the enforcement side.
 */
function setSessionCookies(res: Parameters<typeof ok>[0], session: SessionResult): void {
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
  const { email, password, organizationId, mfaCode } = loginBody.parse(req.body);
  try {
    const session = await login(email, password, {
      organizationId,
      mfaCode,
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
    if (err instanceof MfaRequiredError) {
      // The first call of the two-step flow (no code yet) is not a failure;
      // only a *wrong* code is. Recording the first as LOGIN_FAILED would
      // make every MFA-enabled login look like a failed attempt.
      if (mfaCode) {
        await recordAuthEventSafe({ action: "MFA_CHALLENGE_FAILED", actorEmail: email, result: "FAILURE", req });
      }
      res.status(401).json({ error: { code: err.code, message: err.message, mfaRequired: true } });
      return;
    }
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
authRouter.post("/refresh", requireCsrfHeader, async (req, res, next) => {
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

authRouter.post("/logout", requireCsrfHeader, async (req, res, next) => {
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

const acceptInviteBody = z.object({
  token: z.string().min(1),
  password: z.string().min(10, "Password must be at least 10 characters"),
});

/** Public: the invite token itself is the credential, and the caller isn't signed in yet. */
authRouter.post("/accept-invite", createSensitiveAuthLimiter(), validate({ body: acceptInviteBody }), async (req, res, next) => {
  try {
    const { token, password } = acceptInviteBody.parse(req.body);
    const result = await acceptInvite(token, password);
    await recordAuthEventSafe({
      action: "MEMBER_INVITE_ACCEPTED",
      actorEmail: result.email,
      organizationId: result.organizationId,
      req,
    });
    ok(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

const forgotPasswordBody = z.object({ email: z.string().email() });

/**
 * Always 200, whether or not the address exists — see the OWASP Forgot
 * Password cheat sheet. The real work (sending the email) only happens for
 * a known address, inside `requestPasswordReset`.
 */
authRouter.post("/forgot-password", createSensitiveAuthLimiter(), validate({ body: forgotPasswordBody }), async (req, res, next) => {
  try {
    const { email } = forgotPasswordBody.parse(req.body);
    await requestPasswordReset(email);
    await recordAuthEventSafe({ action: "PASSWORD_RESET_REQUESTED", actorEmail: email, req });
    ok(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

const resetPasswordBody = z.object({
  token: z.string().min(1),
  password: z.string().min(10, "Password must be at least 10 characters"),
});

authRouter.post("/reset-password", createSensitiveAuthLimiter(), validate({ body: resetPasswordBody }), async (req, res, next) => {
  try {
    const { token, password } = resetPasswordBody.parse(req.body);
    const { userId } = await resetPassword(token, password);
    // Resetting a password is exactly the moment to kill every existing
    // session — if the reset was prompted by a leaked credential, a live
    // session under the old password should not survive it.
    await revokeAllRefreshTokens(userId);
    await recordAuthEventSafe({ action: "PASSWORD_RESET_COMPLETED", actorEmail: null, actorUserId: userId, req });
    ok(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, "Password must be at least 10 characters"),
});

authRouter.post("/change-password", requireAuth, validate({ body: changePasswordBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { currentPassword, newPassword } = changePasswordBody.parse(req.body);
    await changePassword(ctx.userId, currentPassword, newPassword);
    await recordAudit(ctx, { action: "PASSWORD_CHANGED", entityType: "User", entityId: ctx.userId, req });
    ok(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

/** Starts TOTP enrollment: returns the secret and an otpauth:// URI for a QR code. */
authRouter.post("/mfa/enroll", requireAuth, async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    ok(res, await startMfaEnrollment(ctx.userId, ctx.email));
  } catch (err) {
    next(err);
  }
});

const mfaCodeBody = z.object({ code: z.string().trim().min(1) });

/** Confirms enrollment with a real code from the authenticator app; returns recovery codes once. */
authRouter.post("/mfa/confirm", requireAuth, validate({ body: mfaCodeBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { code } = mfaCodeBody.parse(req.body);
    const { recoveryCodes } = await confirmMfaEnrollment(ctx.userId, code);
    await recordAudit(ctx, { action: "MFA_ENROLLED", entityType: "User", entityId: ctx.userId, req });
    ok(res, { recoveryCodes });
  } catch (err) {
    next(err);
  }
});

const disableMfaBody = z.object({ password: z.string().min(1), code: z.string().trim().min(1) });

authRouter.post("/mfa/disable", requireAuth, validate({ body: disableMfaBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { password, code } = disableMfaBody.parse(req.body);
    await disableMfa(ctx.userId, password, code);
    await recordAudit(ctx, { action: "MFA_DISABLED", entityType: "User", entityId: ctx.userId, req });
    ok(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

/** Every session still signed in — one row per live refresh token. */
authRouter.get("/sessions", requireAuth, async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    ok(res, await listSessions(ctx.userId));
  } catch (err) {
    next(err);
  }
});

const sessionIdParam = z.object({ id: z.coerce.number().int().positive() });

authRouter.post("/sessions/:id/revoke", requireAuth, validate({ params: sessionIdParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = sessionIdParam.parse(req.params);
    const revoked = await revokeSessionById(ctx.userId, id);
    await recordAudit(ctx, { action: "SESSION_REVOKED", entityType: "RefreshToken", entityId: id, req });
    ok(res, { ok: revoked });
  } catch (err) {
    next(err);
  }
});

/** Revokes every session except the one making this request. */
authRouter.post("/sessions/revoke-others", requireAuth, async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const presented = extractRefreshToken(req);
    if (!presented) {
      ok(res, { ok: false, revokedSessions: 0 });
      return;
    }
    const revoked = await revokeOtherSessions(ctx.userId, hashRefreshToken(presented));
    await recordAudit(ctx, {
      action: "SESSION_REVOKED", entityType: "RefreshToken", metadata: { revokedSessions: revoked }, req,
    });
    ok(res, { ok: true, revokedSessions: revoked });
  } catch (err) {
    next(err);
  }
});
