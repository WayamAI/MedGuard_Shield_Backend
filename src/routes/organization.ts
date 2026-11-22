import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { ok } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../lib/errors.js";
import { recordAudit } from "../services/auditService.js";
import { getOrgSettings, updateOrgSettings } from "../services/orgSettingsService.js";
import { recomputeVendorRisk } from "../services/riskEngine.js";

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

export const settingsBody = z
  .object({
    accessStaleAfterDays: z.coerce.number().int().positive().optional(),
    assessmentCadenceDays: z.coerce.number().int().positive().optional(),
    mfaRequired: z.coerce.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one setting to update" });

organizationRouter.get("/settings", async (req, res, next) => {
  try {
    ok(res, await getOrgSettings(ctxOf(req).organizationId));
  } catch (err) {
    next(err);
  }
});

/**
 * `assessmentCadenceDays` feeds vendor control-gap derivation (a vendor
 * reassessed less often than the cadence counts as a control gap), so
 * changing it can change every vendor's stored score — recomputed here,
 * right after the setting itself is saved. Recompute is already idempotent
 * (ground rule 5: unchanged inputs write no new history row), so recomputing
 * every vendor rather than trying to guess which ones moved costs nothing
 * extra when nothing actually changed.
 */
organizationRouter.patch(
  "/settings", requirePermission("organization:settings:update"), validate({ body: settingsBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const input = settingsBody.parse(req.body);
      const updated = await updateOrgSettings(ctx, input);

      await recordAudit(ctx, {
        action: "SETTINGS_UPDATED", entityType: "OrganizationSettings", entityId: ctx.organizationId,
        metadata: input, req,
      });

      if (input.assessmentCadenceDays !== undefined) {
        const vendors = await prisma.vendor.findMany({
          where: { organizationId: ctx.organizationId, archivedAt: null },
          select: { id: true },
        });
        for (const v of vendors) {
          try {
            await recomputeVendorRisk(ctx, v.id);
          } catch (err) {
            if (!(err instanceof NotFoundError)) throw err; // no assessment yet — nothing to recompute
          }
        }
      }

      ok(res, updated);
    } catch (err) {
      next(err);
    }
  },
);
