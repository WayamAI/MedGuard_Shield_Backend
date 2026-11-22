import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { BadRequestError } from "../lib/errors.js";
import { hashPassword } from "./authService.js";
import { sendMail } from "./mailer.js";

const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes — short, per OWASP guidance

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Always succeeds from the caller's point of view, whether or not the email
 * exists — the route returns the same response either way. No-enumeration
 * per the OWASP Forgot Password cheat sheet.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) return;

  // One live token per user: superseding rather than accumulating keeps a
  // stale link from a week ago from still being usable.
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });

  const token = randomBytes(32).toString("base64url");
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });

  await sendMail({
    to: user.email,
    subject: "Reset your Drishti password",
    text: `Reset your password: /reset-password?token=${token}\n\nThis link expires in 30 minutes and can only be used once.`,
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<{ userId: number }> {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new BadRequestError("This reset link is invalid or has expired");
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  return { userId: record.userId };
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new BadRequestError("Current password is incorrect");
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}
