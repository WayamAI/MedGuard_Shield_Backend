import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok } from "../lib/http.js";
import { recordAudit } from "../services/auditService.js";
import {
  changeMemberRole, deactivateMember, inviteMember,
  listMembers, reactivateMember, resendInvite, revokeInvite,
} from "../services/memberService.js";

export const membersRouter = Router();

const ROLES = ["ADMIN", "ANALYST", "VIEWER"] as const;
export const userIdParam = z.object({ userId: z.coerce.number().int().positive() });
export const inviteIdParam = z.object({ inviteId: z.coerce.number().int().positive() });
const inviteBody = z.object({ email: z.string().email(), role: z.enum(ROLES) });
const roleBody = z.object({ role: z.enum(ROLES) });
membersRouter.get("/", async (req, res, next) => {
  try {
    ok(res, await listMembers(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

membersRouter.post("/invites", requirePermission("member:invite"), validate({ body: inviteBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { email, role } = inviteBody.parse(req.body);
    const invite = await inviteMember(ctx, email, role);
    await recordAudit(ctx, {
      action: "MEMBER_INVITED", entityType: "MemberInvite", entityId: invite.id,
      metadata: { email, role }, req,
    });
    created(res, { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
  } catch (err) {
    next(err);
  }
});

membersRouter.post(
  "/invites/:inviteId/resend", requirePermission("member:invite"), validate({ params: inviteIdParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { inviteId } = inviteIdParam.parse(req.params);
      const invite = await resendInvite(ctx, inviteId);
      await recordAudit(ctx, { action: "MEMBER_INVITE_RESENT", entityType: "MemberInvite", entityId: inviteId, req });
      ok(res, { id: invite.id, expiresAt: invite.expiresAt });
    } catch (err) {
      next(err);
    }
  },
);

membersRouter.delete(
  "/invites/:inviteId", requirePermission("member:invite"), validate({ params: inviteIdParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { inviteId } = inviteIdParam.parse(req.params);
      await revokeInvite(ctx, inviteId);
      await recordAudit(ctx, { action: "MEMBER_INVITE_REVOKED", entityType: "MemberInvite", entityId: inviteId, req });
      ok(res, { ok: true });
    } catch (err) {
      next(err);
    }
  },
);

membersRouter.patch(
  "/:userId/role", requirePermission("member:update"), validate({ params: userIdParam, body: roleBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { userId } = userIdParam.parse(req.params);
      const { role } = roleBody.parse(req.body);
      await changeMemberRole(ctx, userId, role);
      await recordAudit(ctx, {
        action: "MEMBER_ROLE_CHANGED", entityType: "User", entityId: userId, metadata: { role }, req,
      });
      ok(res, { ok: true });
    } catch (err) {
      next(err);
    }
  },
);

membersRouter.post(
  "/:userId/deactivate", requirePermission("member:update"), validate({ params: userIdParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { userId } = userIdParam.parse(req.params);
      await deactivateMember(ctx, userId);
      await recordAudit(ctx, { action: "MEMBER_DEACTIVATED", entityType: "User", entityId: userId, req });
      ok(res, { ok: true });
    } catch (err) {
      next(err);
    }
  },
);

membersRouter.post(
  "/:userId/reactivate", requirePermission("member:update"), validate({ params: userIdParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { userId } = userIdParam.parse(req.params);
      await reactivateMember(ctx, userId);
      await recordAudit(ctx, { action: "MEMBER_REACTIVATED", entityType: "User", entityId: userId, req });
      ok(res, { ok: true });
    } catch (err) {
      next(err);
    }
  },
);
