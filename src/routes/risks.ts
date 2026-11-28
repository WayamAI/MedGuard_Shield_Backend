import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf } from "../middleware/auth.js";
import { ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { listRisks, riskDistribution } from "../services/riskService.js";
import { listRiskHistory, recomputeAssetRisk } from "../services/riskEngine.js";
import { requirePermission } from "../middleware/auth.js";
import { recordAudit } from "../services/auditService.js";
import { maybeSendCsv } from "../lib/csv.js";

export const risksRouter = Router();

const BANDS = ["LOW", "MODERATE", "HIGH", "CRITICAL", "EXTREME"] as const;

export const listQuery = paginationQuery.extend({
  band: z.enum(BANDS).optional(),
  assetId: z.coerce.number().int().positive().optional(),
});

/**
 * Assessment and recompute now live on the asset they belong to
 * (POST /api/assets/:id/assessment and /recompute) rather than here, so a
 * risk write is addressed by its subject. The old
 * POST /api/risks/:assetId/recompute is kept below as an alias so existing
 * clients keep working.
 */
risksRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const q = listQuery.parse(req.query);
    if (req.query.format === "csv") {
      const { items } = await listRisks(ctx, q, {});
      await recordAudit(ctx, { action: "DATA_EXPORTED", entityType: "Risk", metadata: { count: items.length }, req });
      maybeSendCsv(req, res, "risks.csv", items, [
        { header: "Asset", value: (r) => r.assetName },
        { header: "Type", value: (r) => r.assetType },
        { header: "Likelihood", value: (r) => r.likelihood },
        { header: "Impact", value: (r) => r.impact },
        { header: "Exposure", value: (r) => r.exposure },
        { header: "Control Gap", value: (r) => r.controlGap },
        { header: "Score", value: (r) => r.score },
        { header: "Band", value: (r) => r.band },
        { header: "Computed At", value: (r) => r.computedAt?.toISOString?.() ?? "" },
      ]);
      return;
    }
    const page = pageParams(q);
    const { items, total } = await listRisks(ctx, q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

risksRouter.get("/distribution", async (req, res, next) => {
  try {
    ok(res, await riskDistribution(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

export const historyQuery = paginationQuery.extend({
  /** Narrow to asset or vendor movement. Omitted, both are returned. */
  subjectType: z.enum(["ASSET", "VENDOR"]).optional(),
  assetId: z.coerce.number().int().positive().optional(),
  vendorId: z.coerce.number().int().positive().optional(),
});

/** Estate-wide risk movement, assets and vendors alike, newest first. */
risksRouter.get("/history", validate({ query: historyQuery }), async (req, res, next) => {
  try {
    const q = historyQuery.parse(req.query);
    const page = pageParams(q);
    const { entries, total } = await listRiskHistory(ctxOf(req), {
      ...page,
      ...(q.subjectType ? { subjectType: q.subjectType } : {}),
      ...(q.assetId ? { assetId: q.assetId } : {}),
      ...(q.vendorId ? { vendorId: q.vendorId } : {}),
    });
    paged(res, entries, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

/**
 * Backwards-compatible alias for POST /api/assets/:assetId/recompute.
 *
 * Risk writes now live on the asset they belong to, but this path shipped and
 * the frontend calls it. Kept working rather than broken, and documented as
 * deprecated in FRONTEND_API_CONTRACT.md so there is a date on which it can go.
 */
export const assetIdParam = z.object({ assetId: z.coerce.number().int().positive() });

risksRouter.post(
  "/:assetId/recompute",
  requirePermission("asset:assess"),
  validate({ params: assetIdParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { assetId } = assetIdParam.parse(req.params);
      const snapshot = await recomputeAssetRisk(ctx, assetId);

      await recordAudit(ctx, {
        action: "RISK_RECOMPUTED",
        entityType: "Asset",
        entityId: assetId,
        metadata: { score: snapshot.score, band: snapshot.band, via: "deprecated-alias" },
        req,
      });

      ok(res, snapshot);
    } catch (err) {
      next(err);
    }
  },
);
