import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Role } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/errors.js";
import type { TenantContext } from "../lib/tenant.js";

/**
 * Local email + password auth, issuing a short-lived access JWT alongside a
 * long-lived, rotating, opaque refresh token.
 *
 * The seam is deliberately narrow: `requireAuth` depends only on
 * `verifyToken` returning an AuthUser, so swapping in a hosted provider later
 * means reimplementing that one function and deleting the login route.
 *
 * Why the access token got shorter (8h -> 1h): an 8-hour bearer token that
 * cannot be revoked is 8 hours of exposure after a leak. The refresh token can
 * be revoked, is stored only as a hash, rotates on every use, and never leaves
 * an httpOnly cookie — so the long-lived half of the session is the half the
 * server can actually kill.
 */

export type AuthUser = {
  id: number;
  email: string;
  /** Role within `organizationId`, from OrganizationMember. */
  role: Role;
  organizationId: number;
};

/** One hour. Short enough that revocation latency is bounded. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Thirty days. The session the user actually experiences. */
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

class UnauthorizedError extends HttpError {
  constructor(message: string) {
    super(401, message, "UNAUTHORIZED");
  }
}

class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message, "FORBIDDEN");
  }
}

export { UnauthorizedError, ForbiddenError };

/**
 * Fails loudly rather than falling back to a default. A signing key that
 * silently defaults is a signing key an attacker already knows.
 */
function signingSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "JWT_SECRET is missing or too short (need 16+ chars) — see .env.example",
    );
  }
  return secret;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, 10);
}

/**
 * Refresh tokens are stored as SHA-256 digests, not plaintext and not bcrypt.
 *
 * Not plaintext because a database read would then hand over live sessions.
 * Not bcrypt because these are 256 bits of CSPRNG output, not a guessable
 * human secret — there is nothing for a slow hash to defend against, and the
 * refresh path would pay bcrypt's cost on every call.
 */
function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionMembership = {
  organizationId: number;
  organizationName: string;
  organizationSlug: string;
  role: Role;
};

export type SessionResult = {
  token: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: AuthUser;
  /** Every organisation this account belongs to, for an org switcher. */
  memberships: SessionMembership[];
};

function signAccessToken(user: AuthUser): string {
  return jwt.sign(user, signingSecret(), { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

/** Issues and persists a refresh token for one user/organisation pair. */
async function issueRefreshToken(
  userId: number,
  organizationId: number,
  meta: { userAgent?: string | null; ip?: string | null },
): Promise<string> {
  const token = randomBytes(32).toString("hex");

  await prisma.refreshToken.create({
    data: {
      userId,
      organizationId,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    },
  });

  return token;
}

async function membershipsFor(userId: number): Promise<SessionMembership[]> {
  const rows = await prisma.organizationMember.findMany({
    where: { userId },
    include: { organization: { select: { name: true, slug: true } } },
    orderBy: { organizationId: "asc" },
  });

  return rows.map((m) => ({
    organizationId: m.organizationId,
    organizationName: m.organization.name,
    organizationSlug: m.organization.slug,
    role: m.role,
  }));
}

/**
 * Verifies credentials and opens a session.
 *
 * `organizationId` selects which membership to sign in under; omitted, the
 * lowest-numbered one is used. An account with no membership is refused — an
 * authenticated user with no tenant has nothing it could legitimately read,
 * and letting it through would mean every scoped query needed a null case.
 */
export async function login(
  email: string,
  password: string,
  options: { organizationId?: number; userAgent?: string | null; ip?: string | null } = {},
): Promise<SessionResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Same error whether the address is unknown or the password is wrong, so the
  // endpoint cannot be used to enumerate which accounts exist.
  const invalid = new UnauthorizedError("Invalid email or password");
  if (!user?.passwordHash) throw invalid;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw invalid;

  const memberships = await membershipsFor(user.id);
  if (memberships.length === 0) {
    throw new ForbiddenError("This account is not a member of any organization");
  }

  const selected = options.organizationId
    ? memberships.find((m) => m.organizationId === options.organizationId)
    : memberships[0];

  if (!selected) {
    throw new ForbiddenError("This account is not a member of that organization");
  }

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    role: selected.role,
    organizationId: selected.organizationId,
  };

  const refreshToken = await issueRefreshToken(user.id, selected.organizationId, options);

  return {
    token: signAccessToken(authUser),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    user: authUser,
    memberships,
  };
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one.
 *
 * Reuse detection: presenting a token that has already been rotated means
 * either a replay or a stolen copy racing the legitimate holder. Either way
 * the chain is compromised, so **every** live refresh token for that user is
 * revoked and the caller is forced to log in again. Merely rejecting the one
 * token would leave the thief's rotated copy working.
 */
export async function refreshSession(
  presentedToken: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<SessionResult> {
  const tokenHash = hashRefreshToken(presentedToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  const invalid = new UnauthorizedError("Invalid or expired refresh token");
  if (!stored) throw invalid;

  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new UnauthorizedError(
      "Refresh token has already been used. All sessions have been revoked; sign in again.",
    );
  }

  if (stored.expiresAt.getTime() <= Date.now()) throw invalid;

  const membership = await prisma.organizationMember.findUnique({
    where: {
      userId_organizationId: {
        userId: stored.userId,
        organizationId: stored.organizationId,
      },
    },
    include: { user: { select: { email: true } } },
  });

  // Membership can be withdrawn while a refresh token is still live. The token
  // is not evidence of continuing access, so it is re-checked here rather than
  // trusted from issue time.
  if (!membership) {
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    throw new ForbiddenError("This account is no longer a member of that organization");
  }

  const authUser: AuthUser = {
    id: stored.userId,
    email: membership.user.email,
    role: membership.role,
    organizationId: stored.organizationId,
  };

  const nextToken = await issueRefreshToken(stored.userId, stored.organizationId, meta);

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date(), replacedByTokenHash: hashRefreshToken(nextToken) },
  });

  return {
    token: signAccessToken(authUser),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: nextToken,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    user: authUser,
    memberships: await membershipsFor(stored.userId),
  };
}

/** Revokes one refresh token. Returns whether anything was actually live. */
export async function revokeRefreshToken(presentedToken: string): Promise<boolean> {
  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/** Revokes every live refresh token for a user — "sign out everywhere". */
export async function revokeAllRefreshTokens(userId: number): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Decodes and validates an access token. Throws 401 on anything suspect. */
export function verifyToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, signingSecret());
    if (typeof payload === "string") throw new Error("unexpected string payload");

    const { id, email, role, organizationId } = payload as Partial<AuthUser>;
    if (
      typeof id !== "number" ||
      typeof email !== "string" ||
      typeof role !== "string" ||
      typeof organizationId !== "number"
    ) {
      throw new Error("token payload is missing required claims");
    }
    return { id, email, role: role as Role, organizationId };
  } catch {
    throw new UnauthorizedError("Invalid or expired session token");
  }
}

/** The tenant context an authenticated request carries into every service. */
export function contextFor(user: AuthUser): TenantContext {
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
  };
}
