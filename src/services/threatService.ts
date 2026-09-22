import type { Prisma, ThreatSeverity, ThreatStatus } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";

/**
 * The detection feed, now with a real triage lifecycle. Every status change
 * is audited by the route layer with both the old and new status.
 */

const SEVERITY_ORDER: Record<ThreatSeverity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

/** Statuses that still need someone. */
const OPEN_STATUSES: ThreatStatus[] = ["OPEN", "INVESTIGATING"];

/**
 * Which transitions are allowed. A closed threat reopens to OPEN rather than
 * jumping straight back to INVESTIGATING, so "reopened" is always visible as
 * a distinct state in the history.
 */
const ALLOWED_TRANSITIONS: Record<ThreatStatus, ThreatStatus[]> = {
  OPEN: ["INVESTIGATING", "RESOLVED", "FALSE_POSITIVE"],
  INVESTIGATING: ["OPEN", "RESOLVED", "FALSE_POSITIVE"],
  RESOLVED: ["OPEN"],
  FALSE_POSITIVE: ["OPEN"],
};

export function canTransition(from: ThreatStatus, to: ThreatStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type ThreatFilters = {
  status?: ThreatStatus;
  severity?: ThreatSeverity;
  assetId?: number;
  openOnly?: boolean;
  search?: string;
};

function listWhere(ctx: TenantContext, filters: ThreatFilters): Prisma.ThreatWhereInput {
  return {
    ...scope(ctx),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.openOnly ? { status: { in: OPEN_STATUSES } } : {}),
    ...(filters.severity ? { severity: filters.severity } : {}),
    ...(filters.assetId ? { assetId: filters.assetId } : {}),
    ...(filters.search
      ? {
          OR: [
            { title: { contains: filters.search, mode: "insensitive" as const } },
            { description: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

function shape(t: {
  id: number; severity: ThreatSeverity; status: ThreatStatus; title: string;
  description: string; detectedAt: Date; resolvedAt: Date | null;
  asset: { id: number; name: string; type: string };
}) {
  return {
    id: t.id,
    severity: t.severity,
    status: t.status,
    title: t.title,
    description: t.description,
    assetId: t.asset.id,
    assetName: t.asset.name,
    assetType: t.asset.type,
    detectedAt: t.detectedAt,
    resolvedAt: t.resolvedAt,
    hoursSinceDetection: Math.floor((Date.now() - t.detectedAt.getTime()) / (1000 * 60 * 60)),
    open: OPEN_STATUSES.includes(t.status),
  };
}

export async function listThreats(
  ctx: TenantContext,
  filters: ThreatFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where = listWhere(ctx, filters);

  const [rows, total] = await Promise.all([
    prisma.threat.findMany({
      where,
      skip: page.skip,
      take: page.take,
      // Unresolved first, then worst severity, then most recent. Expressed in
      // SQL rather than sorted in memory so it survives pagination.
      orderBy: [{ resolvedAt: { sort: "asc", nulls: "first" } }, { severity: "asc" }, { detectedAt: "desc" }],
      include: { asset: { select: { id: true, name: true, type: true } } },
    }),
    prisma.threat.count({ where }),
  ]);

  const items = rows.map(shape);
  items.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.detectedAt.getTime() - a.detectedAt.getTime();
  });

  return { items, total };
}

/** Estate-wide counts, grouped in SQL rather than over a fetched page. */
export async function threatSummary(ctx: TenantContext) {
  const [bySeverity, byStatus, total] = await Promise.all([
    prisma.threat.groupBy({ by: ["severity"], where: scope(ctx), _count: { _all: true } }),
    prisma.threat.groupBy({ by: ["status"], where: scope(ctx), _count: { _all: true } }),
    prisma.threat.count({ where: scope(ctx) }),
  ]);

  const severity: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const row of bySeverity) severity[row.severity] = row._count._all;

  const status: Record<string, number> = {
    OPEN: 0, INVESTIGATING: 0, RESOLVED: 0, FALSE_POSITIVE: 0,
  };
  for (const row of byStatus) status[row.status] = row._count._all;

  const openCritical = await prisma.threat.count({
    where: { ...scope(ctx), status: { in: OPEN_STATUSES }, severity: "CRITICAL" },
  });

  return {
    total,
    open: (status.OPEN ?? 0) + (status.INVESTIGATING ?? 0),
    bySeverity: severity,
    byStatus: status,
    openCritical,
  };
}

export async function getThreatById(ctx: TenantContext, id: number) {
  const threat = await prisma.threat.findFirst({
    where: { id, ...scope(ctx) },
    include: {
      asset: { select: { id: true, name: true, type: true } },
      remediations: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!threat) throw new NotFoundError(`Threat ${id} not found`);

  return {
    ...shape(threat),
    allowedTransitions: ALLOWED_TRANSITIONS[threat.status],
    remediations: threat.remediations.map((r) => ({
      id: r.id, title: r.title, severity: r.severity, status: r.status, dueAt: r.dueAt,
    })),
  };
}

export type ThreatWriteInput = {
  assetId: number;
  severity: ThreatSeverity;
  title: string;
  description: string;
  status?: ThreatStatus;
  detectedAt?: Date;
};

export async function createThreat(ctx: TenantContext, input: ThreatWriteInput) {
  const asset = await prisma.asset.findFirst({
    where: { id: input.assetId, ...scope(ctx) },
    select: { id: true },
  });
  if (!asset) throw new NotFoundError(`Asset ${input.assetId} not found`);

  const existing = await prisma.threat.findUnique({
    where: { assetId_title: { assetId: input.assetId, title: input.title } },
  });
  if (existing) {
    throw new ConflictError(
      `A threat titled "${input.title}" already exists for asset ${input.assetId}`,
    );
  }

  return prisma.threat.create({
    data: { ...input, organizationId: ctx.organizationId },
  });
}

export async function updateThreat(
  ctx: TenantContext,
  id: number,
  input: { severity?: ThreatSeverity; title?: string; description?: string },
) {
  const threat = await prisma.threat.findFirst({ where: { id, ...scope(ctx) } });
  if (!threat) throw new NotFoundError(`Threat ${id} not found`);

  const after = await prisma.threat.update({ where: { id }, data: input });
  return { before: threat, after };
}

/**
 * Moves a threat through triage.
 *
 * Illegal transitions are refused rather than silently applied: a 409 naming
 * the legal moves is more useful to a UI than a state machine that accepts
 * anything. Reaching a terminal state stamps `resolvedAt`; reopening clears it.
 */
export async function transitionThreat(
  ctx: TenantContext,
  id: number,
  to: ThreatStatus,
) {
  const threat = await prisma.threat.findFirst({ where: { id, ...scope(ctx) } });
  if (!threat) throw new NotFoundError(`Threat ${id} not found`);

  if (threat.status === to) {
    throw new ConflictError(`Threat ${id} is already ${to}`);
  }
  if (!canTransition(threat.status, to)) {
    throw new ConflictError(
      `Cannot move a threat from ${threat.status} to ${to}. Allowed: ${ALLOWED_TRANSITIONS[threat.status].join(", ") || "none"}`,
    );
  }

  const closing = to === "RESOLVED" || to === "FALSE_POSITIVE";
  const after = await prisma.threat.update({
    where: { id },
    data: { status: to, resolvedAt: closing ? new Date() : null },
  });

  return { before: threat, after };
}
