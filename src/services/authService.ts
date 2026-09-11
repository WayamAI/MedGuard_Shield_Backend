import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Role } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/errors.js";

/**
 * Local email + password auth, issuing a signed JWT.
 *
 * B6 offered Supabase Auth or Clerk; both need an account and API keys that
 * this environment cannot create, so this is the self-contained equivalent.
 * The seam is deliberately narrow: requireAuth only depends on
 * `verifyToken` returning an AuthUser, so swapping in a provider SDK later
 * means reimplementing that one function and deleting the login route.
 */

export type AuthUser = {
  id: number;
  email: string;
  role: Role;
};

const TOKEN_TTL_SECONDS = 60 * 60 * 8; // one working day

class UnauthorizedError extends HttpError {
  constructor(message: string) {
    super(401, message, "UNAUTHORIZED");
  }
}

export { UnauthorizedError };

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

/** Verifies credentials and returns a bearer token plus the user it describes. */
export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Same error whether the address is unknown or the password is wrong, so the
  // endpoint cannot be used to enumerate which accounts exist.
  const invalid = new UnauthorizedError("Invalid email or password");
  if (!user?.passwordHash) throw invalid;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw invalid;

  const authUser: AuthUser = { id: user.id, email: user.email, role: user.role };
  const token = jwt.sign(authUser, signingSecret(), { expiresIn: TOKEN_TTL_SECONDS });

  return { token, expiresIn: TOKEN_TTL_SECONDS, user: authUser };
}

/** Decodes and validates a bearer token. Throws 401 on anything suspect. */
export function verifyToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, signingSecret());
    if (typeof payload === "string") throw new Error("unexpected string payload");

    const { id, email, role } = payload as Partial<AuthUser>;
    if (typeof id !== "number" || typeof email !== "string" || typeof role !== "string") {
      throw new Error("token payload is missing required claims");
    }
    return { id, email, role: role as Role };
  } catch {
    throw new UnauthorizedError("Invalid or expired session token");
  }
}
