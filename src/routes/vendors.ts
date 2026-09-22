import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery, sortOrder } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  archiveVendor, createVendor, getVendorById, listVendors,
  restoreVendor, setVendorAssetAccess, updateVendor,
} from "../services/vendorService.js";
import { assessVendor, listRiskHistory, recomputeVendorRisk } from "../services/riskEngine.js";
import { entityHistory } from "../services/auditQueryService.js";
import { onVendorAccessChanged, onVendorChanged, vendorFieldsAffectRisk } from "../services/riskTriggers.js";

export const vendorsRouter = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });
const BAA_STATUSES = ["SIGNED", "PENDING", "EXPIRED", "MISSING"] as const;

const createBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  baaStatus: z.enum(BAA_STATUSES).optional(),
  phiVolume: z.number().int().min(0).optional(),
  lastAssessedAt: z.coerce.date().nullable().optional(),
});

const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);

const listQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(120).optional(),
  baaStatus: z.enum(BAA_STATUSES).optional(),
  includeArchived: z.coerce.boolean().optional(),
  sort: z.enum(["name", "phiVolume", "createdAt"]).optional(),
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


vendorsRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listVendors(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

vendorsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getVendorById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

vendorsRouter.post("/", requirePermission("vendor:create"), validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const vendor = await createVendor(ctx, createBody.parse(req.body));
    await recordAudit(ctx, {
      action: "VENDOR_CREATED", entityType: "Vendor", entityId: vendor.id,
      metadata: { name: vendor.name, baaStatus: vendor.baaStatus }, req,
    });
    created(res, vendor);
  } catch (err) {
    next(err);
  }
});

vendorsRouter.patch(
  "/:id", requirePermission("vendor:update"), validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updateVendor(ctx, id, input);

      await recordAudit(ctx, {
        action: "VENDOR_UPDATED", entityType: "Vendor", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });

      // BAA state and assessment recency feed the vendor's control-gap factor.
      const risk = vendorFieldsAffectRisk(input)
        ? await onVendorChanged(ctx, id, "VENDOR_ACCESS_CHANGED", req)
        : { changed: [] };

      ok(res, { ...after, riskChanged: risk.changed[0] ?? null });
    } catch (err) {
      next(err);
    }
  },
);

vendorsRouter.post("/:id/archive", requirePermission("vendor:archive"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const vendor = await archiveVendor(ctx, id);
    await recordAudit(ctx, {
      action: "VENDOR_ARCHIVED", entityType: "Vendor", entityId: id,
      metadata: { name: vendor.name }, req,
    });
    ok(res, vendor);
  } catch (err) {
    next(err);
  }
});

vendorsRouter.post("/:id/restore", requirePermission("vendor:archive"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { id } = idParam.parse(req.params);
    const vendor = await restoreVendor(ctx, id);
    await recordAudit(ctx, {
      action: "VENDOR_RESTORED", entityType: "Vendor", entityId: id,
      metadata: { name: vendor.name }, req,
    });
    ok(res, vendor);
  } catch (err) {
    next(err);
  }
});

vendorsRouter.post(
  "/:id/assessment", requirePermission("vendor:assess"), validate({ params: idParam, body: assessmentBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const snapshot = await assessVendor(ctx, id, assessmentBody.parse(req.body));
      await recordAudit(ctx, {
        action: snapshot.previous ? "RISK_UPDATED" : "RISK_CREATED",
        entityType: "Vendor", entityId: id,
        metadata: { score: snapshot.score, band: snapshot.band, previous: snapshot.previous },
        req,
      });
      ok(res, snapshot, snapshot.previous ? 200 : 201);
    } catch (err) {
      next(err);
    }
  },
);

vendorsRouter.post(
  "/:id/recompute", requirePermission("vendor:assess"), validate({ params: idParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const snapshot = await recomputeVendorRisk(ctx, id);
      await recordAudit(ctx, {
        action: "RISK_RECOMPUTED", entityType: "Vendor", entityId: id,
        metadata: { score: snapshot.score, band: snapshot.band }, req,
      });
      ok(res, snapshot);
    } catch (err) {
      next(err);
    }
  },
);

const assetLinkParams = z.object({
  id: z.coerce.number().int().positive(),
  assetId: z.coerce.number().int().positive(),
});

vendorsRouter.put(
  "/:id/assets/:assetId", requirePermission("vendor:link-asset"), validate({ params: assetLinkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, assetId } = assetLinkParams.parse(req.params);
      const result = await setVendorAssetAccess(ctx, id, assetId, true);
      await recordAudit(ctx, {
        action: "VENDOR_UPDATED", entityType: "Vendor", entityId: id,
        metadata: { grantedAssetAccess: assetId }, req,
      });
      // Both sides move: the vendor now reaches more PHI, and the asset is now
      // reachable by one more vendor.
      const risk = await onVendorAccessChanged(ctx, id, assetId, req);
      ok(res, { ...result, riskChanged: risk.changed });
    } catch (err) {
      next(err);
    }
  },
);

vendorsRouter.delete(
  "/:id/assets/:assetId", requirePermission("vendor:link-asset"), validate({ params: assetLinkParams }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id, assetId } = assetLinkParams.parse(req.params);
      const result = await setVendorAssetAccess(ctx, id, assetId, false);
      await recordAudit(ctx, {
        action: "VENDOR_UPDATED", entityType: "Vendor", entityId: id,
        metadata: { revokedAssetAccess: assetId }, req,
      });
      // alsoAsset: the link is gone, so walking the vendor's remaining links
      // would miss the asset that just lost it.
      const risk = await onVendorAccessChanged(ctx, id, assetId, req);
      ok(res, { ...result, riskChanged: risk.changed });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Vendor risk movement over time.
 *
 * Shares RiskHistory with assets rather than using a second table -- the four
 * factors, the formula and the bands are identical, and two tables would mean
 * two places to forget to write a row. `subjectType` distinguishes them.
 */
vendorsRouter.get(
  "/:id/risk-history",
  validate({ params: idParam, query: paginationQuery }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);

      // Scoped existence check first, so another tenant's vendor id returns
      // 404 rather than an empty page that looks like "no history yet".
      await getVendorById(ctx, id);

      const page = pageParams(paginationQuery.parse(req.query));
      const { entries, total } = await listRiskHistory(ctx, { vendorId: id, ...page });
      paged(res, entries, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);

vendorsRouter.get(
  "/:id/history", validate({ params: idParam, query: paginationQuery }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      const page = pageParams(paginationQuery.parse(req.query));
      const { items, total } = await entityHistory(ctxOf(req), "Vendor", id, page);
      paged(res, items, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);
