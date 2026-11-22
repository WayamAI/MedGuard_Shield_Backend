import { Router } from "express";
import { z } from "zod";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { validate } from "../middleware/validate.js";
import { ok } from "../lib/http.js";
import { toCsv } from "../lib/csv.js";
import { NotFoundError } from "../lib/errors.js";
import { recordAudit } from "../services/auditService.js";
import { ENTITY_SLUGS, specFor } from "../services/importSpec.js";
import { runImport, validateImport } from "../services/importService.js";
import type { TenantContext } from "../lib/tenant.js";

export const ingestRouter = Router();
ingestRouter.use(requireApiKey);

const ingestBody = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "At least one row is required"),
  dryRun: z.boolean().optional(),
});

/**
 * Converts JSON rows to the exact CSV text `importService.ts` already
 * validates and commits, so ingestion runs through the *same* pipeline as a
 * CSV upload rather than a parallel one — one set of validation rules, one
 * place that can have a bug in it.
 */
function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return toCsv(rows, columns.map((column) => ({ header: column, value: (r: Record<string, unknown>) => r[column] })));
}

ingestRouter.post("/:recordType", validate({ body: ingestBody }), async (req, res, next) => {
  const ctx = req.ctx as TenantContext & { connectorId: number; connectorLabel: string };
  const slug = Array.isArray(req.params.recordType) ? req.params.recordType[0] : req.params.recordType;
  const spec = specFor(slug ?? "");
  if (!spec) {
    next(new NotFoundError(`Unknown import entity "${slug}". Supported: ${ENTITY_SLUGS.join(", ")}`));
    return;
  }

  const { rows, dryRun } = ingestBody.parse(req.body);
  const csvText = rowsToCsv(spec.columns.map((c) => c.column), rows);
  const common = { via: "ingest-api", connectorId: ctx.connectorId, connectorLabel: ctx.connectorLabel, entity: spec.slug, rowCount: rows.length };

  try {
    if (dryRun) {
      const report = await validateImport(ctx, spec, csvText);
      await recordAudit(ctx, { action: "IMPORT_STARTED", entityType: "Import", metadata: { ...common, dryRun: true }, req });
      ok(res, report);
      return;
    }

    await recordAudit(ctx, { action: "IMPORT_STARTED", entityType: "Import", metadata: common, req });
    const result = await runImport(ctx, spec, csvText);

    if (!result.valid) {
      await recordAudit(ctx, {
        action: "IMPORT_FAILED", entityType: "Import", result: "FAILURE",
        metadata: { ...common, totalRows: result.totalRows, errorCount: result.errors.length }, req,
      });
      res.status(400).json({
        error: {
          code: "IMPORT_VALIDATION_FAILED",
          message: `${result.errors.length} problem(s) found. Nothing was imported.`,
          report: result,
        },
      });
      return;
    }

    await recordAudit(ctx, {
      action: "IMPORT_COMPLETED", entityType: "Import",
      metadata: { ...common, totalRows: result.totalRows, imported: result.imported }, req,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    await recordAudit(ctx, {
      action: "IMPORT_FAILED", entityType: "Import", result: "FAILURE",
      metadata: { ...common, reason: err instanceof Error ? err.message : "unknown" }, req,
    }).catch(() => undefined);
    next(err);
  }
});
