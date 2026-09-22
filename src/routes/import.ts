import { Router, type RequestHandler } from "express";
import multer from "multer";
import { ctxOf, requireRole } from "../middleware/auth.js";
import { recordAudit } from "../services/auditService.js";
import { BadRequestError, HttpError, NotFoundError } from "../lib/errors.js";
import { templateCsv } from "../services/importParsing.js";
import { runImport, validateImport } from "../services/importService.js";
import { ENTITY_SLUGS, specFor, type EntitySpec } from "../services/importSpec.js";

export const importRouter = Router();

/** Two megabytes. A realistic estate export is tens of kilobytes. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MB = MAX_BYTES / (1024 * 1024);

/**
 * Import writes directly into the PHI inventory, so it is ADMIN-only —
 * narrower than the ADMIN/ANALYST gate on ordinary writes. The template
 * endpoint is gated identically: the column list describes the shape of the
 * estate and there is no reason for it to be broader than the operation it
 * exists to support.
 */
const adminOnly = requireRole(["ADMIN"]);

/**
 * Files are held in memory, never written to disk. Nothing in the pipeline
 * executes a cell — values are coerced to string, number, boolean or Date and
 * handed to Prisma as bound parameters.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const named = file.originalname.toLowerCase().endsWith(".csv");
    if (!named) {
      cb(new BadRequestError(`Only .csv files are accepted, got "${file.originalname}"`));
      return;
    }
    cb(null, true);
  },
});

/**
 * multer reports its own failures through next(err) with codes rather than
 * statuses, so they are translated here instead of reaching the catch-all as
 * unclassified 500s.
 */
const uploadCsv: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new HttpError(413, `File exceeds the ${MAX_MB}MB limit`, "FILE_TOO_LARGE"));
        return;
      }
      next(new BadRequestError(`Upload rejected: ${err.message}`));
      return;
    }
    next(err);
  });
};

/** Resolves :entity or fails with the list of what is actually supported. */
function requireSpec(raw: string | string[] | undefined): EntitySpec {
  const slug = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const spec = specFor(slug);
  if (!spec) {
    throw new NotFoundError(
      `Unknown import entity "${slug}". Supported: ${ENTITY_SLUGS.join(", ")}`,
    );
  }
  return spec;
}

function csvTextFrom(file: Express.Multer.File | undefined): string {
  if (!file) {
    throw new BadRequestError('No file uploaded. Send the CSV as multipart form field "file".');
  }
  return file.buffer.toString("utf8");
}

/** The column contract itself, useful for a UI building its own hints. */
importRouter.get("/", adminOnly, (_req, res) => {
  res.json({
    data: ENTITY_SLUGS.map((slug) => {
      const spec = specFor(slug);
      return {
        entity: slug,
        label: spec?.label,
        model: spec?.model,
        naturalKey: spec?.naturalKey,
        naturalKeyLabel: spec?.naturalKeyLabel,
        columns: spec?.columns.map((c) => ({
          column: c.column,
          type: c.type,
          required: c.required,
          values: c.values,
          referencesModel: c.ref?.target,
          description: c.description,
        })),
      };
    }),
  });
});

importRouter.get("/:entity/template", adminOnly, (req, res, next) => {
  try {
    const spec = requireSpec(req.params.entity);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="drishti-${spec.slug}-template.csv"`);
    res.send(templateCsv(spec));
  } catch (err) {
    next(err);
  }
});

importRouter.post("/:entity/validate", adminOnly, uploadCsv, async (req, res, next) => {
  try {
    const spec = requireSpec(req.params.entity);
    const report = await validateImport(ctxOf(req), spec, csvTextFrom(req.file));
    // A dry run that found problems is a successful dry run, so this is 200
    // with valid:false rather than an error status.
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
});

importRouter.post("/:entity", adminOnly, uploadCsv, async (req, res, next) => {
  const ctx = ctxOf(req);
  let spec;
  try {
    spec = requireSpec(req.params.entity);
  } catch (err) {
    next(err);
    return;
  }

  const filename = req.file?.originalname ?? null;

  try {
    // Recorded before the work starts, so an import that crashes mid-flight
    // still leaves evidence that it was attempted and by whom.
    await recordAudit(ctx, {
      action: "IMPORT_STARTED",
      entityType: "Import",
      metadata: { entity: spec.slug, filename, bytes: req.file?.size ?? null },
      req,
    });

    const result = await runImport(ctx, spec, csvTextFrom(req.file));

    if (!result.valid) {
      await recordAudit(ctx, {
        action: "IMPORT_FAILED",
        entityType: "Import",
        result: "FAILURE",
        metadata: {
          entity: spec.slug, filename,
          totalRows: result.totalRows, errorCount: result.errors.length,
        },
        req,
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
      action: "IMPORT_COMPLETED",
      entityType: "Import",
      metadata: {
        entity: spec.slug, filename,
        totalRows: result.totalRows, imported: result.imported,
      },
      req,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    // A thrown import (bad file, oversized upload, database error) is still a
    // failed import and is recorded as one before the error propagates.
    await recordAudit(ctx, {
      action: "IMPORT_FAILED",
      entityType: "Import",
      result: "FAILURE",
      metadata: {
        entity: spec.slug, filename,
        reason: err instanceof Error ? err.message : "unknown",
      },
      req,
    }).catch(() => undefined);
    next(err);
  }
});
