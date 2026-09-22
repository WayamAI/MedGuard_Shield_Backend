import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requireRole } from "../middleware/auth.js";
import { created, ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  assignRemediation, createRemediation, getRemediationById, listRemediations,
  remediationSummary, transitionRemediation, updateRemediation,
} from "../services/remediationService.js";
import { entityHistory } from "../services/auditQueryService.js";

export const remediationsRouter = Router();

const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "ACCEPTED", "REOPENED"] as const;
const SOURCES = ["RISK", "THREAT", "ACCESS", "VENDOR", "CONTROL", "MANUAL"] as const;

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = paginationQuery.extend({
  status: z.enum(STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  source: z.enum(SOURCES).optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  assetId: z.coerce.number().int().positive().optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  openOnly: z.coerce.boolean().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000),
  recommendation: z.string().trim().min(1).max(4000),
  severity: z.enum(SEVERITIES).optional(),
  source: z.enum(SOURCES).optional(),
  ownerId: z.coerce.number().int().positive().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  assetId: z.coerce.number().int().positive().nullable().optional(),
  vendorId: z.coerce.number().int().positive().nullable().optional(),
  threatId: z.coerce.number().int().positive().nullable().optional(),
  controlId: z.coerce.number().int().positive().nullable().optional(),
  identityId: z.coerce.number().int().positive().nullable().optional(),
  accessGrantId: z.coerce.number().int().positive().nullable().optional(),
});

const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);

const transitionBody = z.object({ status: z.enum(STATUSES) });
const assignBody = z.object({ ownerId: z.coerce.number().int().positive().nullable() });

const canWrite = requireRole(["ADMIN", "ANALYST"]);

remediationsRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listRemediations(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

remediationsRouter.get("/summary", async (req, res, next) => {
  try {
    ok(res, await remediationSummary(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

remediationsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getRemediationById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

remediationsRouter.post("/", canWrite, validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const item = await createRemediation(ctx, createBody.parse(req.body));
    await recordAudit(ctx, {
      action: "REMEDIATION_CREATED", entityType: "Remediation", entityId: item.id,
      metadata: { title: item.title, severity: item.severity, source: item.source },
      req,
    });
    created(res, item);
  } catch (err) {
    next(err);
  }
});

remediationsRouter.patch(
  "/:id", canWrite, validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const input = patchBody.parse(req.body);
      const { before, after } = await updateRemediation(ctx, id, input);
      await recordAudit(ctx, {
        action: "REMEDIATION_UPDATED", entityType: "Remediation", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Moves work through its lifecycle.
 *
 * Note what this does **not** do: it does not reach over and change the asset,
 * control or threat the finding points at. Marking work resolved records that
 * someone says it is done — a claim about people — and is not the same as the
 * estate having changed. Conflating the two would put an assertion in the
 * compliance record that nobody actually performed.
 */
remediationsRouter.post(
  "/:id/status", canWrite, validate({ params: idParam, body: transitionBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const { status } = transitionBody.parse(req.body);
      const { before, after } = await transitionRemediation(ctx, id, status);

      const action =
        status === "RESOLVED" ? "REMEDIATION_RESOLVED"
        : status === "REOPENED" ? "REMEDIATION_REOPENED"
        : "REMEDIATION_UPDATED";

      await recordAudit(ctx, {
        action, entityType: "Remediation", entityId: id,
        metadata: { from: before.status, to: after.status, title: after.title }, req,
      });

      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

remediationsRouter.post(
  "/:id/assign", canWrite, validate({ params: idParam, body: assignBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const { ownerId } = assignBody.parse(req.body);
      const { before, after } = await assignRemediation(ctx, id, ownerId);
      await recordAudit(ctx, {
        action: "REMEDIATION_ASSIGNED", entityType: "Remediation", entityId: id,
        metadata: { from: before.ownerId, to: ownerId }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);

remediationsRouter.get(
  "/:id/history", validate({ params: idParam, query: paginationQuery }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      const page = pageParams(paginationQuery.parse(req.query));
      const { items, total } = await entityHistory(ctxOf(req), "Remediation", id, page);
      paged(res, items, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);
