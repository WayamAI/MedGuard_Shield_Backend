import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requireRole } from "../middleware/auth.js";
import { paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { listAuditEvents } from "../services/auditQueryService.js";

export const auditRouter = Router();

const ACTIONS = [
  "LOGIN", "LOGIN_FAILED", "LOGOUT", "TOKEN_REFRESHED", "TOKEN_REVOKED",
  "ASSET_CREATED", "ASSET_UPDATED", "ASSET_ARCHIVED", "ASSET_RESTORED",
  "RISK_CREATED", "RISK_UPDATED", "RISK_RECOMPUTED",
  "VENDOR_CREATED", "VENDOR_UPDATED", "VENDOR_ARCHIVED", "VENDOR_RESTORED",
  "IDENTITY_CREATED", "IDENTITY_UPDATED", "IDENTITY_ARCHIVED",
  "ACCESS_GRANTED", "ACCESS_UPDATED", "ACCESS_REVOKED", "ACCESS_REVIEWED",
  "THREAT_CREATED", "THREAT_UPDATED", "THREAT_STATUS_CHANGED",
  "CONTROL_CREATED", "CONTROL_UPDATED", "CONTROL_ARCHIVED",
  "CONTROL_LINKED_ASSET", "CONTROL_UNLINKED_ASSET",
  "POLICY_CREATED", "POLICY_UPDATED", "POLICY_ARCHIVED",
  "REMEDIATION_CREATED", "REMEDIATION_UPDATED", "REMEDIATION_ASSIGNED",
  "REMEDIATION_RESOLVED", "REMEDIATION_REOPENED",
  "IMPORT_STARTED", "IMPORT_COMPLETED", "IMPORT_FAILED",
] as const;

const listQuery = paginationQuery.extend({
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
  requireRole(["ADMIN"]),
  validate({ query: listQuery }),
  async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const page = pageParams(q);
      const { items, total } = await listAuditEvents(ctxOf(req), q, page);
      paged(res, items, pageMeta(page, total));
    } catch (err) {
      next(err);
    }
  },
);
