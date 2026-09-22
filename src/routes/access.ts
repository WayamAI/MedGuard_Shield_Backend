import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  accessSummary, getAccessGrantById, grantAccess, listAccessGrants,
  reviewAccessGrant, revokeAccessGrant, updateAccessGrant,
} from "../services/accessService.js";

export const accessRouter = Router();

const LEVELS = ["READ", "WRITE", "ADMIN"] as const;
const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = paginationQuery.extend({
  assetId: z.coerce.number().int().positive().optional(),
  identityId: z.coerce.number().int().positive().optional(),
  level: z.enum(LEVELS).optional(),
  flaggedOnly: z.coerce.boolean().optional(),
  includeRevoked: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

const grantBody = z.object({
  identityId: z.coerce.number().int().positive(),
  assetId: z.coerce.number().int().positive(),
  level: z.enum(LEVELS).optional(),
  grantedAt: z.coerce.date().optional(),
  lastUsedAt: z.coerce.date().nullable().optional(),
});

const patchBody = z
  .object({
    level: z.enum(LEVELS).optional(),
    lastUsedAt: z.coerce.date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });


accessRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listAccessGrants(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

/** Estate-wide counts, over every live grant rather than one page. */
accessRouter.get("/summary", async (req, res, next) => {
  try {
    ok(res, await accessSummary(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

accessRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getAccessGrantById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

accessRouter.post("/", requirePermission("access:grant"), validate({ body: grantBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const input = grantBody.parse(req.body);
    const grant = await grantAccess(ctx, input);
    await recordAudit(ctx, {
      action: "ACCESS_GRANTED", entityType: "AccessGrant", entityId: grant.id,
      metadata: { identityId: grant.identityId, assetId: grant.assetId, level: grant.level },
      req,
    });
    created(res, grant);
  } catch (err) {
    next(err);
  }
});

accessRouter.patch(
  "/:id", requirePermission("access:update"), validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updateAccessGrant(ctx, id, input);
      await recordAudit(ctx, {
        action: "ACCESS_UPDATED", entityType: "AccessGrant", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Revokes access. The row is kept with `revokedAt` set — who lost which access
 * and when is the question an access review has to answer later, and a DELETE
 * destroys it. There is deliberately no DELETE on this resource.
 */
accessRouter.post("/:id/revoke", requirePermission("access:revoke"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const grant = await revokeAccessGrant(ctx, id);
    await recordAudit(ctx, {
      action: "ACCESS_REVOKED", entityType: "AccessGrant", entityId: id,
      metadata: { identityId: grant.identityId, assetId: grant.assetId, level: grant.level },
      req,
    });
    ok(res, grant);
  } catch (err) {
    next(err);
  }
});

/** Attests that a human looked at this grant. Clears the NEVER_REVIEWED flag. */
accessRouter.post("/:id/review", requirePermission("access:review"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const grant = await reviewAccessGrant(ctx, id);
    await recordAudit(ctx, {
      action: "ACCESS_REVIEWED", entityType: "AccessGrant", entityId: id,
      metadata: { reviewedAt: grant.lastReviewedAt }, req,
    });
    ok(res, grant);
  } catch (err) {
    next(err);
  }
});
