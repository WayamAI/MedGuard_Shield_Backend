import { Router } from "express";
import { ctxOf } from "../middleware/auth.js";
import { ok } from "../lib/http.js";
import { toCsv } from "../lib/csv.js";
import { recordAudit } from "../services/auditService.js";
import { riskAssessmentDetail, riskAssessmentSummary } from "../services/reportService.js";
import { renderRiskAssessmentPdf } from "../services/reportPdf.js";

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

reportsRouter.get("/risk-assessment.pdf", async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const detail = await riskAssessmentDetail(ctx);
    const pdf = await renderRiskAssessmentPdf(detail, ctx);
    await recordAudit(ctx, {
      action: "REPORT_GENERATED",
      entityType: "Report",
      entityId: undefined,
      metadata: { report: "risk-assessment", format: "pdf" },
      req,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="risk-assessment.pdf"');
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get("/risk-assessment.csv", async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const detail = await riskAssessmentDetail(ctx);
    await recordAudit(ctx, {
      action: "REPORT_GENERATED",
      entityType: "Report",
      entityId: undefined,
      metadata: { report: "risk-assessment", format: "csv" },
      req,
    });
    const csv = toCsv(
      detail.topRisks as Array<{ assetName: string; assetType: string; score: number; band: string }>,
      [
        { header: "Asset", value: (r) => r.assetName },
        { header: "Type", value: (r) => r.assetType },
        { header: "Score", value: (r) => r.score },
        { header: "Band", value: (r) => r.band },
      ],
    );
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="risk-assessment.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
