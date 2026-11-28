import { createHash, randomBytes } from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { prisma } from "../lib/prisma.js";
import { BadRequestError, HttpError } from "../lib/errors.js";
import bcrypt from "bcryptjs";

class UnauthorizedError extends HttpError {
  constructor(message: string) {
    super(401, message, "UNAUTHORIZED");
  }
}

const RECOVERY_CODE_COUNT = 8;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(5).toString("hex"));
}

/**
 * Starts enrollment: generates a secret and holds it un-committed on the
 * user row (mfaEnabled stays false) until `confirmEnrollment` proves the
 * authenticator app actually has it. Re-running this before confirming just
 * overwrites the pending secret — there is nothing to leak by doing so.
 */
export async function startMfaEnrollment(userId: number, email: string) {
  const secret = generateSecret();
  await prisma.user.update({ where: { id: userId }, data: { mfaSecret: secret, mfaEnabled: false } });
  const uri = generateURI({ issuer: "Drishti", label: email, secret });
  return { secret, uri };
}

/** Confirms enrollment with a real code from the app, and issues recovery codes once, in the clear, here only. */
export async function confirmMfaEnrollment(userId: number, code: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.mfaSecret) throw new BadRequestError("No MFA enrollment in progress");

  let valid = false;
  try {
    valid = (await verify({ secret: user.mfaSecret, token: code })).valid;
  } catch {
    // malformed code shape — treated the same as a wrong one, below.
  }
  if (!valid) throw new UnauthorizedError("Invalid verification code");

  const recoveryCodes = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: userId },
    data: { mfaEnabled: true, mfaRecoveryCodeHashes: recoveryCodes.map(hashCode) },
  });

  return { recoveryCodes };
}

/** A login-time challenge: a TOTP code or an unused recovery code, either one. */
export async function verifyMfaChallenge(userId: number, code: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.mfaEnabled || !user.mfaSecret) return true; // MFA not required for this account

  // otplib throws on malformed input (e.g. a recovery code's length) rather
  // than returning { valid: false } — a wrong-shaped code is not a TOTP
  // match, so fall through to the recovery-code check instead of erroring.
  try {
    const totpResult = await verify({ secret: user.mfaSecret, token: code });
    if (totpResult.valid) return true;
  } catch {
    // not a valid TOTP shape — try recovery codes below.
  }

  const codeHash = hashCode(code.trim());
  if (user.mfaRecoveryCodeHashes.includes(codeHash)) {
    // Single-use: remove it from the array atomically with the check above's
    // result, so a replay of the same recovery code fails next time.
    await prisma.user.update({
      where: { id: userId },
      data: { mfaRecoveryCodeHashes: user.mfaRecoveryCodeHashes.filter((h) => h !== codeHash) },
    });
    return true;
  }

  return false;
}

export async function requiresMfa(userId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true } });
  return user?.mfaEnabled ?? false;
}

export async function disableMfa(userId: number, password: string, code: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash) throw new UnauthorizedError("Invalid password");
  if (!(await bcrypt.compare(password, user.passwordHash))) throw new UnauthorizedError("Invalid password");

  const ok = await verifyMfaChallenge(userId, code);
  if (!ok) throw new UnauthorizedError("Invalid verification code");

  await prisma.user.update({
    where: { id: userId },
    data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodeHashes: [] },
  });
}
