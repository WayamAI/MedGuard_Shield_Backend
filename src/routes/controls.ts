import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requireRole } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  archiveControl, createControl, getControlById, listControls, setAssetControl, updateControl,
} from "../services/controlService.js";

export const controlsRouter = Router();

const CATEGORIES = ["ACCESS", "ENCRYPTION", "MONITORING", "GOVERNANCE", "RESILIENCE", "VENDOR"] as const;
const STATUSES = ["IMPLEMENTED", "PARTIAL", "PLANNED", "NOT_IMPLEMENTED"] as const;
const EFFECTIVENESS = ["EFFECTIVE", "PARTIALLY_EFFECTIVE", "INEFFECTIVE", "NOT_ASSESSED"] as const;

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(120).optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(STATUSES).optional(),
  effectiveness: z.enum(EFFECTIVENESS).optional(),
  includeArchived: z.coerce.boolean().optional(),
});

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  category: z.enum(CATEGORIES),
  status: z.enum(STATUSES).optional(),
  effectiveness: z.enum(EFFECTIVENESS).optional(),
  owner: z.string().trim().max(120).nullable().optional(),
  /**
   * A reference the customer typed, e.g. "HIPAA 164.312(a)(1)". Stored as a
   * pointer only — Drishti asserts no conformance on the strength of it.
   */
  frameworkRef: z.string().trim().max(200).nullable().optional(),
  lastReviewedAt: z.coerce.date().nullable().optional(),
});

const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);

const canWrite = requireRole(["ADMIN", "ANALYST"]);
const adminOnly = requireRole(["ADMIN"]);

controlsRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listControls(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

controlsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getControlById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

controlsRouter.post("/", canWrite, validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const control = await createControl(ctx, createBody.parse(req.body));
    await recordAudit(ctx, {
      action: "CONTROL_CREATED", entityType: "Control", entityId: control.id,
      metadata: { name: control.name, category: control.category, status: control.status },
      req,
    });
    created(res, control);
  } catch (err) {
    next(err);
  }
});

controlsRouter.patch(
  "/:id", canWrite, validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updateControl(ctx, id, input);
      await recordAudit(ctx, {
        action: "CONTROL_UPDATED", entityType: "Control", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

controlsRouter.post("/:id/archive", adminOnly, validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const control = await archiveControl(ctx, id);
    await recordAudit(ctx, {
      action: "CONTROL_ARCHIVED", entityType: "Control", entityId: id,
      metadata: { name: control.name }, req,
    });
    ok(res, control);
  } catch (err) {
    next(err);
  }
});

const linkParams = z.object({
  id: z.coerce.number().int().positive(),
  assetId: z.coerce.number().int().positive(),
});

controlsRouter.put(
  "/:id/assets/:assetId", canWrite, validate({ params: linkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, assetId } = linkParams.parse(req.params);
      const result = await setAssetControl(ctx, id, assetId, true);
      await recordAudit(ctx, {
        action: "CONTROL_LINKED_ASSET", entityType: "Control", entityId: id,
        metadata: { assetId }, req,
      });
      ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);

controlsRouter.delete(
  "/:id/assets/:assetId", canWrite, validate({ params: linkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, assetId } = linkParams.parse(req.params);
      const result = await setAssetControl(ctx, id, assetId, false);
      await recordAudit(ctx, {
        action: "CONTROL_UNLINKED_ASSET", entityType: "Control", entityId: id,
        metadata: { assetId }, req,
      });
      ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);
