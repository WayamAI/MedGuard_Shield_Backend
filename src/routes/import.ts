import { Router, type RequestHandler } from "express";
import multer from "multer";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { recordAudit } from "../services/auditService.js";
import { BadRequestError, HttpError, NotFoundError } from "../lib/errors.js";
import { templateCsv, templateXlsx } from "../services/importParsing.js";
import { runImport, validateImport, type ImportFile } from "../services/importService.js";
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
const canReadContract = requirePermission("import:read");
const canImport = requirePermission("import:execute");

/**
 * Files are held in memory, never written to disk. Nothing in the pipeline
 * executes a cell — values are coerced to string, number, boolean or Date and
 * handed to Prisma as bound parameters.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (!name.endsWith(".csv") && !name.endsWith(".xlsx")) {
      cb(new BadRequestError(`Only .csv or .xlsx files are accepted, got "${file.originalname}"`));
      return;
    }
    cb(null, true);
  },
});

/** Picks the parser by filename. Only reached once fileFilter has already approved the extension. */
function importFileFrom(file: Express.Multer.File | undefined): ImportFile {
  if (!file) {
    throw new BadRequestError('No file uploaded. Send the file as multipart form field "file".');
  }
  if (file.originalname.toLowerCase().endsWith(".xlsx")) {
    return { format: "xlsx", buffer: file.buffer };
  }
  return { format: "csv", text: file.buffer.toString("utf8") };
}

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

/** The column contract itself, useful for a UI building its own hints. */
importRouter.get("/", canReadContract, (_req, res) => {
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

importRouter.get("/:entity/template", canReadContract, async (req, res, next) => {
  try {
    const spec = requireSpec(req.params.entity);
    if (req.query.format === "xlsx") {
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="drishti-${spec.slug}-template.xlsx"`);
      res.send(await templateXlsx(spec));
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="drishti-${spec.slug}-template.csv"`);
    res.send(templateCsv(spec));
  } catch (err) {
    next(err);
  }
});

importRouter.post("/:entity/validate", canImport, uploadCsv, async (req, res, next) => {
  try {
    const spec = requireSpec(req.params.entity);
    const report = await validateImport(ctxOf(req), spec, importFileFrom(req.file));
    // A dry run that found problems is a successful dry run, so this is 200
    // with valid:false rather than an error status.
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
});

importRouter.post("/:entity", canImport, uploadCsv, async (req, res, next) => {
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

    const result = await runImport(ctx, spec, importFileFrom(req.file));

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
