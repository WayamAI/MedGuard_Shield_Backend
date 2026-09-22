import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  archiveIdentity, createIdentity, getIdentityById, listIdentities, updateIdentity,
} from "../services/identityService.js";
import { onAssetsChanged } from "../services/riskTriggers.js";
import { prisma } from "../lib/prisma.js";

export const identitiesRouter = Router();

const KINDS = ["USER", "SERVICE_ACCOUNT"] as const;
const ROLES = ["ADMIN", "ANALYST", "VIEWER"] as const;
const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(KINDS).optional(),
  active: z.coerce.boolean().optional(),
  includeArchived: z.coerce.boolean().optional(),
});

const createBody = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().email().nullable().optional(),
  kind: z.enum(KINDS).optional(),
  department: z.string().trim().max(120).nullable().optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  mfaEnabled: z.boolean().optional(),
});

const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);


identitiesRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listIdentities(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

identitiesRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getIdentityById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

identitiesRouter.post("/", requirePermission("identity:create"), validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const identity = await createIdentity(ctx, createBody.parse(req.body));
    await recordAudit(ctx, {
      action: "IDENTITY_CREATED", entityType: "Identity", entityId: identity.id,
      metadata: { displayName: identity.displayName, kind: identity.kind }, req,
    });
    created(res, identity);
  } catch (err) {
    next(err);
  }
});

identitiesRouter.patch(
  "/:id", requirePermission("identity:update"), validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updateIdentity(ctx, id, input);
      await recordAudit(ctx, {
        action: "IDENTITY_UPDATED", entityType: "Identity", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Archives an identity and revokes everything it could reach, atomically.
 *
 * Deactivating a leaver without removing their access is the exact failure
 * this product exists to surface, so the two are not separable here.
 */
identitiesRouter.post("/:id/archive", requirePermission("identity:archive"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);

    // Captured before archiving, because archiving revokes the grants and the
    // assets they pointed at would otherwise be unreachable from here.
    const affected = await prisma.accessGrant.findMany({
      where: { identityId: id, revokedAt: null, organizationId: ctx.organizationId },
      select: { assetId: true },
    });

    const result = await archiveIdentity(ctx, id);
    await recordAudit(ctx, {
      action: "IDENTITY_ARCHIVED", entityType: "Identity", entityId: id,
      metadata: {
        displayName: result.identity.displayName,
        revokedGrants: result.revokedGrants,
      },
      req,
    });

    // Revoking a leaver's access reduces the exposure of everything they
    // could reach.
    const risk = await onAssetsChanged(
      ctx, affected.map((g) => g.assetId), "ACCESS_CHANGED", req,
    );

    ok(res, { ...result, riskChanged: risk.changed });
  } catch (err) {
    next(err);
  }
});
