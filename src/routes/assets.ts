import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery, sortOrder } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  archiveAsset, createAsset, getAssetById, listAssets, restoreAsset, updateAsset,
} from "../services/assetService.js";
import { assessAsset, listRiskHistory, recomputeAssetRisk } from "../services/riskEngine.js";
import { controlGapEvidence, setAssetControl } from "../services/controlService.js";
import { entityHistory } from "../services/auditQueryService.js";
import { assetFieldsAffectRisk, onAssetChanged } from "../services/riskTriggers.js";

export const assetsRouter = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

const ASSET_TYPES = ["EHR", "DATABASE", "API", "CLOUD_STORAGE", "ANALYTICS", "OTHER"] as const;
const BANDS = ["LOW", "MODERATE", "HIGH", "CRITICAL", "EXTREME"] as const;

const createBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  type: z.enum(ASSET_TYPES),
  phiVolume: z.number().int().min(0).optional(),
  encrypted: z.boolean().optional(),
  mfaEnabled: z.boolean().optional(),
  lastAssessedAt: z.coerce.date().nullable().optional(),
});

// Every field optional, but not an empty object -- a PATCH that changes
// nothing is a client mistake worth surfacing rather than a silent no-op.
const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);

const listQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(120).optional(),
  type: z.enum(ASSET_TYPES).optional(),
  band: z.enum(BANDS).optional(),
  includeArchived: z.coerce.boolean().optional(),
  sort: z.enum(["name", "phiVolume", "riskScore", "createdAt"]).optional(),
  order: sortOrder.optional(),
});

/**
 * An assessment.
 *
 * `likelihood` and `impact` are required: they are judgement, and nothing in
 * the graph can supply them. `exposure` and `controlGap` are optional and are
 * derived from recorded facts when omitted -- supplying either pins it against
 * automatic recalculation, which is how an assessor overrides the derivation.
 */
const assessmentBody = z.object({
  likelihood: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  exposure: z.number().int().min(1).max(5).optional(),
  controlGap: z.number().int().min(1).max(5).optional(),
});


assetsRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listAssets(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

assetsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getAssetById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

assetsRouter.post("/", requirePermission("asset:create"), validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const asset = await createAsset(ctx, createBody.parse(req.body));
    await recordAudit(ctx, {
      action: "ASSET_CREATED",
      entityType: "Asset",
      entityId: asset.id,
      metadata: { name: asset.name, type: asset.type },
      req,
    });
    created(res, asset);
  } catch (err) {
    next(err);
  }
});

assetsRouter.patch(
  "/:id",
  requirePermission("asset:update"),
  validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updateAsset(ctx, id, input);

      await recordAudit(ctx, {
        action: "ASSET_UPDATED",
        entityType: "Asset",
        entityId: id,
        metadata: { changes: diffFields(before, input) },
        req,
      });

      // PHI volume, encryption and MFA feed the derived exposure factor.
      // Renaming an asset cannot move a score, so it does not trigger one.
      const risk = assetFieldsAffectRisk(input)
        ? await onAssetChanged(ctx, id, "ASSET_CHANGED", req)
        : { changed: [] };

      ok(res, { ...after, riskChanged: risk.changed[0] ?? null });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Archive rather than delete. There is no DELETE on this resource at all: an
 * asset that held PHI stays part of the compliance record, and cascading its
 * threats, grants and risk history away is exactly what an auditor would ask
 * us to explain.
 */
assetsRouter.post("/:id/archive", requirePermission("asset:archive"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const asset = await archiveAsset(ctx, id);
    await recordAudit(ctx, {
      action: "ASSET_ARCHIVED", entityType: "Asset", entityId: id,
      metadata: { name: asset.name }, req,
    });
    ok(res, asset);
  } catch (err) {
    next(err);
  }
});

assetsRouter.post("/:id/restore", requirePermission("asset:archive"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const asset = await restoreAsset(ctx, id);
    await recordAudit(ctx, {
      action: "ASSET_RESTORED", entityType: "Asset", entityId: id,
      metadata: { name: asset.name }, req,
    });
    ok(res, asset);
  } catch (err) {
    next(err);
  }
});

/**
 * Records an assessment. This is the path that did not exist before: the four
 * 1-5 inputs could previously only enter by CSV import.
 */
assetsRouter.post(
  "/:id/assessment",
  requirePermission("asset:assess"),
  validate({ params: idParam, body: assessmentBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const snapshot = await assessAsset(ctx, id, assessmentBody.parse(req.body));

      await recordAudit(ctx, {
        action: snapshot.previous ? "RISK_UPDATED" : "RISK_CREATED",
        entityType: "Asset",
        entityId: id,
        metadata: {
          score: snapshot.score, band: snapshot.band,
          previousScore: snapshot.previous?.score ?? null,
          previousBand: snapshot.previous?.band ?? null,
        },
        req,
      });

      ok(res, snapshot, snapshot.previous ? 200 : 201);
    } catch (err) {
      next(err);
    }
  },
);

assetsRouter.post(
  "/:id/recompute",
  requirePermission("asset:assess"),
  validate({ params: idParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const snapshot = await recomputeAssetRisk(ctx, id);

      await recordAudit(ctx, {
        action: "RISK_RECOMPUTED",
        entityType: "Asset",
        entityId: id,
        metadata: {
          score: snapshot.score, band: snapshot.band,
          previousScore: snapshot.previous?.score ?? null,
          changed: snapshot.changed,
        },
        req,
      });

      ok(res, snapshot);
    } catch (err) {
      next(err);
    }
  },
);

/** Risk movement over time for one asset, newest first. */
assetsRouter.get(
  "/:id/risk-history",
  validate({ params: idParam, query: paginationQuery }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      const page = pageParams(paginationQuery.parse(req.query));
      const { entries, total } = await listRiskHistory(ctxOf(req), { assetId: id, ...page });
      paged(res, entries, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);

/** The audit trail for one asset. */
assetsRouter.get(
  "/:id/history",
  validate({ params: idParam, query: paginationQuery }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      const page = pageParams(paginationQuery.parse(req.query));
      const { items, total } = await entityHistory(ctxOf(req), "Asset", id, page);
      paged(res, items, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Control coverage as evidence for a control-gap judgement. Returns a
 * suggestion; applying it is a separate, explicit assessment call.
 */
assetsRouter.get(
  "/:id/control-evidence",
  validate({ params: idParam }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      ok(res, await controlGapEvidence(ctxOf(req), id));
    } catch (err) {
      next(err);
    }
  },
);

const controlLinkParams = z.object({
  id: z.coerce.number().int().positive(),
  controlId: z.coerce.number().int().positive(),
});

assetsRouter.put(
  "/:id/controls/:controlId",
  requirePermission("asset:link-control"),
  validate({ params: controlLinkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, controlId } = controlLinkParams.parse(req.params);
      const result = await setAssetControl(ctx, controlId, id, true);
      await recordAudit(ctx, {
        action: "CONTROL_LINKED_ASSET", entityType: "Asset", entityId: id,
        metadata: { controlId }, req,
      });
      const risk = await onAssetChanged(ctx, id, "CONTROL_CHANGED", req);
      ok(res, { ...result, riskChanged: risk.changed[0] ?? null });
    } catch (err) {
      next(err);
    }
  },
);

assetsRouter.delete(
  "/:id/controls/:controlId",
  requirePermission("asset:link-control"),
  validate({ params: controlLinkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, controlId } = controlLinkParams.parse(req.params);
      const result = await setAssetControl(ctx, controlId, id, false);
      await recordAudit(ctx, {
        action: "CONTROL_UNLINKED_ASSET", entityType: "Asset", entityId: id,
        metadata: { controlId }, req,
      });
      const risk = await onAssetChanged(ctx, id, "CONTROL_CHANGED", req);
      ok(res, { ...result, riskChanged: risk.changed[0] ?? null });
    } catch (err) {
      next(err);
    }
  },
);
