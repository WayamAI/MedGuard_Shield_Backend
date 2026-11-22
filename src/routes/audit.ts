import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { listAuditEvents, verifyAuditChain } from "../services/auditQueryService.js";
import { recordAudit } from "../services/auditService.js";
import { maybeSendCsv } from "../lib/csv.js";
import { AuditAction } from "../generated/prisma/client.js";

export const auditRouter = Router();

/**
 * Every value `AuditAction` has, read off the generated Prisma enum rather
 * than hand-copied — the whole reason this list went stale twice before
 * (new actions kept landing in schema.prisma without this file noticing).
 */
const ACTIONS = Object.values(AuditAction) as [AuditAction, ...AuditAction[]];

export const listQuery = paginationQuery.extend({
  action: z.enum(ACTIONS).optional(),
  entityType: z.string().trim().max(50).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  actorUserId: z.coerce.number().int().positive().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * The audit trail is ADMIN-only. It names who did what and from which IP,
 * which is more than an analyst needs and exactly what an account-compromise
 * investigation would want to keep narrow.
 *
 * Read-only by design: there is no POST, PATCH or DELETE here, and the table
 * has no writer outside auditService.ts.
 */
auditRouter.get(
  "/",
  requirePermission("audit:read"),
  validate({ query: listQuery }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const q = listQuery.parse(req.query);
      if (req.query.format === "csv") {
        const { items } = await listAuditEvents(ctx, q, {});
        await recordAudit(ctx, { action: "DATA_EXPORTED", entityType: "AuditEvent", metadata: { count: items.length }, req });
        maybeSendCsv(req, res, "audit-log.csv", items, [
          { header: "ID", value: (e) => e.id },
          { header: "Timestamp", value: (e) => e.createdAt?.toISOString?.() ?? e.createdAt },
          { header: "Actor", value: (e) => e.actor?.email ?? "" },
          { header: "Action", value: (e) => e.action },
          { header: "Entity Type", value: (e) => e.entityType ?? "" },
          { header: "Entity ID", value: (e) => e.entityId ?? "" },
          { header: "Result", value: (e) => e.result },
          { header: "IP", value: (e) => e.ip ?? "" },
        ]);
        return;
      }
      const page = pageParams(q);
      const { items, total } = await listAuditEvents(ctx, q, page);
      paged(res, items, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);

/** Walks the hash chain and reports whether it's intact, and where it first breaks if not. */
auditRouter.get("/verify", requirePermission("audit:read"), async (req, res, next) => {
  try {
    ok(res, await verifyAuditChain(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});
