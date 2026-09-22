import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf } from "../middleware/auth.js";
import { ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { listRisks, riskDistribution } from "../services/riskService.js";
import { listRiskHistory } from "../services/riskEngine.js";

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
