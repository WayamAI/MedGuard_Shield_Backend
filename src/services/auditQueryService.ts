import type { AuditAction, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { scope, type TenantContext } from "../lib/tenant.js";

/**
 * Read side of the audit trail. There is deliberately no update or delete
 * anywhere in this module — the table is append-only, and the only writer is
 * auditService.ts.
 */

export type AuditFilters = {
  action?: AuditAction;
  entityType?: string;
  entityId?: number;
  actorUserId?: number;
  from?: Date;
  to?: Date;
};

export async function listAuditEvents(
  ctx: TenantContext,
  filters: AuditFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where: Prisma.AuditEventWhereInput = {
    ...scope(ctx),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: page.skip,
      take: page.take,
    }),
    prisma.auditEvent.count({ where }),
  ]);

  return {
    total,
    items: rows.map((e) => ({
      id: e.id,
      action: e.action,
      actor: e.actorUserId ? { id: e.actorUserId, email: e.actorEmail } : null,
      entityType: e.entityType,
      entityId: e.entityId,
      result: e.result,
      metadata: e.metadata,
      ip: e.ip,
      createdAt: e.createdAt,
    })),
  };
}

/** The trail for one record, for an entity detail page's History tab. */
export async function entityHistory(
  ctx: TenantContext,
  entityType: string,
  entityId: number,
  page: { skip?: number; take?: number } = {},
) {
  return listAuditEvents(ctx, { entityType, entityId }, page);
}
