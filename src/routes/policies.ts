import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  archivePolicy, createPolicy, getPolicyById, listPolicies, setPolicyControl, updatePolicy,
} from "../services/policyService.js";

export const policiesRouter = Router();

const STATUSES = ["DRAFT", "ACTIVE", "UNDER_REVIEW", "ARCHIVED"] as const;
const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(120).optional(),
  status: z.enum(STATUSES).optional(),
  includeArchived: z.coerce.boolean().optional(),
});

const createBody = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4000),
  status: z.enum(STATUSES).optional(),
  owner: z.string().trim().max(120).nullable().optional(),
  evidenceRef: z.string().trim().max(500).nullable().optional(),
  reviewDueAt: z.coerce.date().nullable().optional(),
});

const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);


policiesRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listPolicies(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

policiesRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getPolicyById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

policiesRouter.post("/", requirePermission("policy:create"), validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const policy = await createPolicy(ctx, createBody.parse(req.body));
    await recordAudit(ctx, {
      action: "POLICY_CREATED", entityType: "Policy", entityId: policy.id,
      metadata: { name: policy.name, status: policy.status }, req,
    });
    created(res, policy);
  } catch (err) {
    next(err);
  }
});

policiesRouter.patch(
  "/:id", requirePermission("policy:update"), validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updatePolicy(ctx, id, input);
      await recordAudit(ctx, {
        action: "POLICY_UPDATED", entityType: "Policy", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

policiesRouter.post("/:id/archive", requirePermission("policy:archive"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const policy = await archivePolicy(ctx, id);
    await recordAudit(ctx, {
      action: "POLICY_ARCHIVED", entityType: "Policy", entityId: id,
      metadata: { name: policy.name }, req,
    });
    ok(res, policy);
  } catch (err) {
    next(err);
  }
});

const linkParams = z.object({
  id: z.coerce.number().int().positive(),
  controlId: z.coerce.number().int().positive(),
});

policiesRouter.put(
  "/:id/controls/:controlId", requirePermission("policy:link-control"), validate({ params: linkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, controlId } = linkParams.parse(req.params);
      const result = await setPolicyControl(ctx, id, controlId, true);
      await recordAudit(ctx, {
        action: "POLICY_UPDATED", entityType: "Policy", entityId: id,
        metadata: { linkedControl: controlId }, req,
      });
      ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);

policiesRouter.delete(
  "/:id/controls/:controlId", requirePermission("policy:link-control"), validate({ params: linkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, controlId } = linkParams.parse(req.params);
      const result = await setPolicyControl(ctx, id, controlId, false);
      await recordAudit(ctx, {
        action: "POLICY_UPDATED", entityType: "Policy", entityId: id,
        metadata: { unlinkedControl: controlId }, req,
      });
      ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);
