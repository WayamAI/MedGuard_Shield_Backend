import { Router } from "express";
import { ctxOf } from "../middleware/auth.js";
import { ok } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../lib/errors.js";

export const organizationRouter = Router();

/**
 * The caller's organisation. Reads `ctx.organizationId` from the verified
 * session — there is no `:id` parameter, because an endpoint that let a caller
 * name the organisation would be the tenant boundary's one hole.
 */
organizationRouter.get("/", async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const org = await prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      include: {
        _count: {
          select: {
            members: true, assets: true, vendors: true, identities: true,
            threats: true, controls: true, policies: true, remediations: true,
          },
        },
      },
    });
    if (!org) throw new NotFoundError("Organization not found");

    ok(res, {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt,
      counts: org._count,
      yourRole: ctx.role,
    });
  } catch (err) {
    next(err);
  }
});

/** Members of the caller's organisation, for remediation owner pickers. */
organizationRouter.get("/members", async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const members = await prisma.organizationMember.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: { select: { id: true, email: true, createdAt: true } } },
      orderBy: { userId: "asc" },
    });

    ok(
      res,
      members.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        role: m.role,
        memberSince: m.createdAt,
      })),
    );
  } catch (err) {
    next(err);
  }
});
