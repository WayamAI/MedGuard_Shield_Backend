import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requireRole } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  createThreat, getThreatById, listThreats, threatSummary, transitionThreat, updateThreat,
} from "../services/threatService.js";
import { entityHistory } from "../services/auditQueryService.js";

export const threatsRouter = Router();

const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const STATUSES = ["OPEN", "INVESTIGATING", "RESOLVED", "FALSE_POSITIVE"] as const;
const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = paginationQuery.extend({
  status: z.enum(STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  assetId: z.coerce.number().int().positive().optional(),
  openOnly: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

const createBody = z.object({
  assetId: z.coerce.number().int().positive(),
  severity: z.enum(SEVERITIES),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000),
  status: z.enum(STATUSES).optional(),
  detectedAt: z.coerce.date().optional(),
});

const patchBody = z
  .object({
    severity: z.enum(SEVERITIES).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

const transitionBody = z.object({ status: z.enum(STATUSES) });

const canWrite = requireRole(["ADMIN", "ANALYST"]);

threatsRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listThreats(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

threatsRouter.get("/summary", async (req, res, next) => {
  try {
    ok(res, await threatSummary(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

threatsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getThreatById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

threatsRouter.post("/", canWrite, validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const threat = await createThreat(ctx, createBody.parse(req.body));
    await recordAudit(ctx, {
      action: "THREAT_CREATED", entityType: "Threat", entityId: threat.id,
      metadata: { title: threat.title, severity: threat.severity, assetId: threat.assetId },
      req,
    });
    created(res, threat);
  } catch (err) {
    next(err);
  }
});

threatsRouter.patch(
  "/:id", canWrite, validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updateThreat(ctx, id, input);
      await recordAudit(ctx, {
        action: "THREAT_UPDATED", entityType: "Threat", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Triage. Illegal moves are refused with a 409 naming the legal ones, so a UI
 * can render the right buttons rather than discovering the state machine by
 * trial and error. Every transition is audited with both statuses.
 */
threatsRouter.post(
  "/:id/status", canWrite, validate({ params: idParam, body: transitionBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const { status } = transitionBody.parse(req.body);
      const { before, after } = await transitionThreat(ctx, id, status);

      await recordAudit(ctx, {
        action: "THREAT_STATUS_CHANGED", entityType: "Threat", entityId: id,
        metadata: { from: before.status, to: after.status, title: after.title }, req,
      });

      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

threatsRouter.get(
  "/:id/history", validate({ params: idParam, query: paginationQuery }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      const page = pageParams(paginationQuery.parse(req.query));
      const { items, total } = await entityHistory(ctxOf(req), "Threat", id, page);
      paged(res, items, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);
