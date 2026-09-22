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

export const risksRouter = Router();

const BANDS = ["LOW", "MODERATE", "HIGH", "CRITICAL", "EXTREME"] as const;

const listQuery = paginationQuery.extend({
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
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listRisks(ctxOf(req), q, page);
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

/** Estate-wide risk movement, newest first. */
risksRouter.get("/history", validate({ query: paginationQuery }), async (req, res, next) => {
  try {
    const page = pageParams(paginationQuery.parse(req.query));
    const { entries, total } = await listRiskHistory(ctxOf(req), page);
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
const assetIdParam = z.object({ assetId: z.coerce.number().int().positive() });

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
