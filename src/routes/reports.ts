import { Router } from "express";
import { ctxOf } from "../middleware/auth.js";
import { ok } from "../lib/http.js";
import { riskAssessmentSummary } from "../services/reportService.js";

export const reportsRouter = Router();

/**
 * Risk Assessment Summary, as structured JSON.
 *
 * Every figure is counted from persisted rows at request time. There is no
 * compliance score and no invented weighting: the percentages reported are
 * coverage ratios over recorded data, and the payload carries a disclaimer
 * saying exactly that.
 */
reportsRouter.get("/risk-assessment", async (req, res, next) => {
  try {
    ok(res, await riskAssessmentSummary(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});
