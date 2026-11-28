import { randomBytes, createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import type { Role } from "../generated/prisma/client.js";
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors.js";
import { hashPassword } from "./authService.js";
import { sendMail } from "./mailer.js";
import type { TenantContext } from "../lib/tenant.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function listMembers(ctx: TenantContext) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId: ctx.organizationId },
    include: { user: { select: { id: true, email: true, createdAt: true, mfaEnabled: true } } },
    orderBy: { userId: "asc" },
  });
  return members.map((m) => ({
    userId: m.user.id,
    email: m.user.email,
    role: m.role,
    active: m.active,
    mfaEnabled: m.user.mfaEnabled,
    memberSince: m.createdAt,
  }));
}

/**
 * Invites someone by email. If they already have a Drishti account, the
 * invite still goes through the accept flow (it only sets org membership,
 * not a password) — simpler than branching the UX on whether the address is
 * known, and it still can't be used to probe which emails exist, because the
 * response is identical either way.
 */
export async function inviteMember(ctx: TenantContext, email: string, role: Role) {
  const normalized = email.trim().toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email: normalized } });
  if (existingUser) {
    const existingMembership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: existingUser.id, organizationId: ctx.organizationId } },
    });
    if (existingMembership) throw new ConflictError(`${normalized} is already a member of this organization`);
  }

  const token = newToken();
  const invite = await prisma.memberInvite.create({
    data: {
      organizationId: ctx.organizationId,
      email: normalized,
      role,
      tokenHash: hashToken(token),
      invitedById: ctx.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  await sendMail({
    to: normalized,
    subject: "You've been invited to Drishti",
    text: `You've been invited to join a Drishti organization as ${role}.\n\nAccept: /accept-invite?token=${token}\n\nThis link expires in 7 days.`,
  });

  return invite;
}

export async function resendInvite(ctx: TenantContext, inviteId: number) {
  const invite = await prisma.memberInvite.findFirst({
    where: { id: inviteId, organizationId: ctx.organizationId, acceptedAt: null },
  });
  if (!invite) throw new NotFoundError("Invite not found");

  const token = newToken();
  const updated = await prisma.memberInvite.update({
    where: { id: invite.id },
    data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });

  await sendMail({
    to: invite.email,
    subject: "You've been invited to Drishti",
    text: `Reminder: you've been invited to join a Drishti organization as ${invite.role}.\n\nAccept: /accept-invite?token=${token}\n\nThis link expires in 7 days.`,
  });

  return updated;
}

export async function revokeInvite(ctx: TenantContext, inviteId: number) {
  const invite = await prisma.memberInvite.findFirst({
    where: { id: inviteId, organizationId: ctx.organizationId, acceptedAt: null },
  });
  if (!invite) throw new NotFoundError("Invite not found");
  await prisma.memberInvite.delete({ where: { id: invite.id } });
}

/** Sets a password and creates (or confirms) the membership. No session is returned — the caller still has to log in. */
export async function acceptInvite(token: string, password: string) {
  const invite = await prisma.memberInvite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    throw new BadRequestError("This invite link is invalid or has expired");
  }

  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: invite.email },
      update: {},
      create: { email: invite.email, role: invite.role, passwordHash },
    });

    await tx.organizationMember.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: invite.organizationId } },
      update: { active: true, role: invite.role },
      create: { userId: user.id, organizationId: invite.organizationId, role: invite.role },
    });

    // Only set the password if this is genuinely a new account; an invite
    // sent to an existing Drishti user should not silently change their
    // credential for every organization they belong to.
    if (!user.passwordHash) {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    }

    await tx.memberInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
  });

  return { email: invite.email, organizationId: invite.organizationId, role: invite.role };
}

export async function changeMemberRole(ctx: TenantContext, userId: number, role: Role) {
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
  });
  if (!membership) throw new NotFoundError("Member not found");

  if (membership.role === "ADMIN" && role !== "ADMIN") {
    await assertNotLastActiveAdmin(ctx.organizationId, userId);
  }

  return prisma.organizationMember.update({
    where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
    data: { role },
  });
}

export async function deactivateMember(ctx: TenantContext, userId: number) {
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
  });
  if (!membership) throw new NotFoundError("Member not found");

  if (membership.role === "ADMIN") {
    await assertNotLastActiveAdmin(ctx.organizationId, userId);
  }

  return prisma.organizationMember.update({
    where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
    data: { active: false },
  });
}

export async function reactivateMember(ctx: TenantContext, userId: number) {
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
  });
  if (!membership) throw new NotFoundError("Member not found");

  return prisma.organizationMember.update({
    where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
    data: { active: true },
  });
}

/** Refuses to leave an organization with no active admin. */
async function assertNotLastActiveAdmin(organizationId: number, excludingUserId: number) {
  const otherActiveAdmins = await prisma.organizationMember.count({
    where: { organizationId, role: "ADMIN", active: true, userId: { not: excludingUserId } },
  });
  if (otherActiveAdmins === 0) {
    throw new ConflictError("Cannot remove the last active admin of this organization");
  }
}
