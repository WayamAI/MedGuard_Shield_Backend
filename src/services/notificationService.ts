import { prisma } from "../lib/prisma.js";
import { pageMeta, type PageParams } from "../lib/pagination.js";
import type { TenantContext } from "../lib/tenant.js";
import type { NotificationType } from "../generated/prisma/client.js";

type NotificationInput = {
  organizationId: number;
  type: NotificationType;
  title: string;
  body: string;
  entityType: string;
  entityId: number;
  /** Unique per org: the same condition re-detected tomorrow is a no-op, not a second row. */
  dedupeKey: string;
};

/** Upserts on the dedupe key, so re-running the sweep against a still-true condition creates nothing new. */
async function upsertNotification(input: NotificationInput): Promise<boolean> {
  const existing = await prisma.notification.findUnique({
    where: { organizationId_dedupeKey: { organizationId: input.organizationId, dedupeKey: input.dedupeKey } },
  });
  if (existing) return false;
  await prisma.notification.create({ data: input });
  return true;
}

export async function listNotifications(ctx: TenantContext, page: PageParams) {
  const where = { organizationId: ctx.organizationId };
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.take }),
    prisma.notification.count({ where }),
  ]);
  return {
    items: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      entityType: n.entityType,
      entityId: n.entityId,
      read: n.readByUserIds.includes(ctx.userId),
      createdAt: n.createdAt,
    })),
    meta: pageMeta(page, total),
  };
}

export async function unreadCount(ctx: TenantContext): Promise<number> {
  const rows = await prisma.notification.findMany({
    where: { organizationId: ctx.organizationId },
    select: { readByUserIds: true },
  });
  return rows.filter((n) => !n.readByUserIds.includes(ctx.userId)).length;
}

export async function markRead(ctx: TenantContext, id: number): Promise<void> {
  const n = await prisma.notification.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!n || n.readByUserIds.includes(ctx.userId)) return;
  await prisma.notification.update({
    where: { id },
    data: { readByUserIds: [...n.readByUserIds, ctx.userId] },
  });
}

export async function markAllRead(ctx: TenantContext): Promise<number> {
  const rows = await prisma.notification.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, readByUserIds: true },
  });
  const unread = rows.filter((n) => !n.readByUserIds.includes(ctx.userId));
  await Promise.all(
    unread.map((n) =>
      prisma.notification.update({
        where: { id: n.id },
        data: { readByUserIds: [...n.readByUserIds, ctx.userId] },
      }),
    ),
  );
  return unread.length;
}

/** Called from threatService.createThreat — the one event-driven (not swept) notification. */
export async function notifyNewHighSeverityThreat(
  organizationId: number,
  threat: { id: number; title: string; severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; assetId: number },
): Promise<void> {
  if (threat.severity !== "CRITICAL" && threat.severity !== "HIGH") return;
  await upsertNotification({
    organizationId,
    type: "THREAT_NEW_HIGH_SEVERITY",
    title: `New ${threat.severity} threat: ${threat.title}`,
    body: `A new ${threat.severity.toLowerCase()}-severity threat was detected.`,
    entityType: "Threat",
    entityId: threat.id,
    dedupeKey: `threat-new:${threat.id}`,
  });
}

/**
 * Time-based findings, evaluated against current state. Idempotent per the
 * dedupe key: run it daily, run it twice in a row, run it after a restart —
 * each already-notified-and-still-true condition creates nothing new.
 */
export async function runNotificationSweep(organizationId: number): Promise<{ created: number }> {
  const settings = await prisma.organizationSettings.findUnique({ where: { organizationId } });
  const assessmentCadenceDays = settings?.assessmentCadenceDays ?? 365;
  const now = new Date();
  let created = 0;

  const overdueRemediations = await prisma.remediation.findMany({
    where: { organizationId, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] }, dueAt: { lt: now } },
    select: { id: true, title: true },
  });
  for (const r of overdueRemediations) {
    if (
      await upsertNotification({
        organizationId, type: "REMEDIATION_OVERDUE", title: `Remediation overdue: ${r.title}`,
        body: "This remediation passed its due date without being resolved.",
        entityType: "Remediation", entityId: r.id, dedupeKey: `remediation-overdue:${r.id}`,
      })
    ) created++;
  }

  const invalidBaaVendors = await prisma.vendor.findMany({
    where: { organizationId, archivedAt: null, baaStatus: { in: ["MISSING", "EXPIRED"] } },
    select: { id: true, name: true, baaStatus: true },
  });
  for (const v of invalidBaaVendors) {
    if (
      await upsertNotification({
        organizationId, type: "VENDOR_BAA_INVALID", title: `${v.name}: BAA ${v.baaStatus}`,
        body: `This vendor's Business Associate Agreement is ${v.baaStatus.toLowerCase()}.`,
        entityType: "Vendor", entityId: v.id, dedupeKey: `vendor-baa:${v.id}:${v.baaStatus}`,
      })
    ) created++;
  }

  const vendors = await prisma.vendor.findMany({
    where: { organizationId, archivedAt: null },
    select: { id: true, name: true, lastAssessedAt: true },
  });
  for (const v of vendors) {
    const overdue =
      v.lastAssessedAt === null ||
      (now.getTime() - v.lastAssessedAt.getTime()) / 86_400_000 > assessmentCadenceDays;
    if (!overdue) continue;
    if (
      await upsertNotification({
        organizationId, type: "VENDOR_ASSESSMENT_OVERDUE", title: `${v.name}: assessment overdue`,
        body: "This vendor has not been reassessed within the configured cadence.",
        entityType: "Vendor", entityId: v.id, dedupeKey: `vendor-assessment:${v.id}`,
      })
    ) created++;
  }

  const overduePolicies = await prisma.policy.findMany({
    where: { organizationId, archivedAt: null, reviewDueAt: { lt: now } },
    select: { id: true, name: true },
  });
  for (const p of overduePolicies) {
    if (
      await upsertNotification({
        organizationId, type: "POLICY_REVIEW_OVERDUE", title: `Policy review overdue: ${p.name}`,
        body: "This policy's review date has passed.",
        entityType: "Policy", entityId: p.id, dedupeKey: `policy-review:${p.id}`,
      })
    ) created++;
  }

  const grants = await prisma.accessGrant.findMany({
    where: { organizationId, revokedAt: null },
    include: {
      identity: { select: { active: true, kind: true, mfaEnabled: true, displayName: true } },
      asset: { select: { name: true, phiVolume: true } },
    },
  });
  const { flagsFor } = await import("./accessService.js");
  for (const g of grants) {
    const flags = flagsFor(g, settings?.accessStaleAfterDays ?? 90);
    if (flags.length === 0) continue;
    if (
      await upsertNotification({
        organizationId, type: "ACCESS_GRANT_FLAGGED",
        title: `Access grant flagged: ${g.identity.displayName} → ${g.asset.name}`,
        body: `Flags: ${flags.join(", ")}`,
        entityType: "AccessGrant", entityId: g.id, dedupeKey: `access-flagged:${g.id}:${flags.sort().join(",")}`,
      })
    ) created++;
  }

  return { created };
}
