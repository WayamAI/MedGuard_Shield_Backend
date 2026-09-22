import type {
  FindingSource, Prisma, RemediationSeverity, RemediationStatus,
} from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";

/**
 * Findings and the work to close them.
 *
 * This is the subsystem that replaces the frontend's fabricated "Violation
 * resolved, encryption applied." Resolving a remediation here persists a
 * status, a timestamp and an actor, and writes an audit event — and it does
 * **not** reach over and change the underlying asset. Marking the work done is
 * not the same as the work being done, and conflating them would put a claim
 * in the record that nobody performed.
 */

const SEVERITY_RANK: Record<RemediationSeverity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

const OPEN_STATUSES: RemediationStatus[] = ["OPEN", "IN_PROGRESS", "REOPENED"];

/**
 * Legal moves. ACCEPTED means risk accepted without fixing — a real outcome
 * that must be distinguishable from RESOLVED in any report.
 */
const ALLOWED_TRANSITIONS: Record<RemediationStatus, RemediationStatus[]> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "ACCEPTED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "ACCEPTED"],
  REOPENED: ["IN_PROGRESS", "RESOLVED", "ACCEPTED"],
  RESOLVED: ["REOPENED"],
  ACCEPTED: ["REOPENED"],
};

export function canTransition(from: RemediationStatus, to: RemediationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type RemediationFilters = {
  status?: RemediationStatus;
  severity?: RemediationSeverity;
  source?: FindingSource;
  ownerId?: number;
  assetId?: number;
  vendorId?: number;
  openOnly?: boolean;
  overdueOnly?: boolean;
  search?: string;
};

function listWhere(ctx: TenantContext, f: RemediationFilters): Prisma.RemediationWhereInput {
  return {
    ...scope(ctx),
    ...(f.status ? { status: f.status } : {}),
    ...(f.openOnly ? { status: { in: OPEN_STATUSES } } : {}),
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.ownerId ? { ownerId: f.ownerId } : {}),
    ...(f.assetId ? { assetId: f.assetId } : {}),
    ...(f.vendorId ? { vendorId: f.vendorId } : {}),
    ...(f.overdueOnly
      ? { dueAt: { lt: new Date() }, status: { in: OPEN_STATUSES } }
      : {}),
    ...(f.search
      ? {
          OR: [
            { title: { contains: f.search, mode: "insensitive" as const } },
            { description: { contains: f.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

const LIST_INCLUDE = {
  owner: { select: { id: true, email: true } },
  asset: { select: { id: true, name: true } },
  vendor: { select: { id: true, name: true } },
  threat: { select: { id: true, title: true } },
  control: { select: { id: true, name: true } },
  identity: { select: { id: true, displayName: true } },
} as const;

type RemediationRow = Prisma.RemediationGetPayload<{ include: typeof LIST_INCLUDE }>;

function shape(r: RemediationRow) {
  const open = OPEN_STATUSES.includes(r.status);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    recommendation: r.recommendation,
    severity: r.severity,
    status: r.status,
    source: r.source,
    open,
    owner: r.owner ? { id: r.owner.id, email: r.owner.email } : null,
    dueAt: r.dueAt,
    overdue: open && r.dueAt !== null && r.dueAt.getTime() < Date.now(),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    resolvedAt: r.resolvedAt,
    subject: {
      asset: r.asset ? { id: r.asset.id, name: r.asset.name } : null,
      vendor: r.vendor ? { id: r.vendor.id, name: r.vendor.name } : null,
      threat: r.threat ? { id: r.threat.id, title: r.threat.title } : null,
      control: r.control ? { id: r.control.id, name: r.control.name } : null,
      identity: r.identity ? { id: r.identity.id, name: r.identity.displayName } : null,
      accessGrantId: r.accessGrantId,
    },
  };
}

export async function listRemediations(
  ctx: TenantContext,
  filters: RemediationFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where = listWhere(ctx, filters);

  const [rows, total] = await Promise.all([
    prisma.remediation.findMany({
      where,
      skip: page.skip,
      take: page.take,
      orderBy: [{ severity: "asc" }, { dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      include: LIST_INCLUDE,
    }),
    prisma.remediation.count({ where }),
  ]);

  const items = rows.map(shape);
  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { items, total };
}

export async function remediationSummary(ctx: TenantContext) {
  const [byStatus, bySeverity, overdue] = await Promise.all([
    prisma.remediation.groupBy({ by: ["status"], where: scope(ctx), _count: { _all: true } }),
    prisma.remediation.groupBy({ by: ["severity"], where: scope(ctx), _count: { _all: true } }),
    prisma.remediation.count({
      where: { ...scope(ctx), status: { in: OPEN_STATUSES }, dueAt: { lt: new Date() } },
    }),
  ]);

  const status: Record<string, number> = {
    OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, ACCEPTED: 0, REOPENED: 0,
  };
  for (const r of byStatus) status[r.status] = r._count._all;

  const severity: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const r of bySeverity) severity[r.severity] = r._count._all;

  return {
    total: Object.values(status).reduce((a, b) => a + b, 0),
    open: (status.OPEN ?? 0) + (status.IN_PROGRESS ?? 0) + (status.REOPENED ?? 0),
    byStatus: status,
    bySeverity: severity,
    overdue,
  };
}

export async function getRemediationById(ctx: TenantContext, id: number) {
  const row = await prisma.remediation.findFirst({
    where: { id, ...scope(ctx) },
    include: LIST_INCLUDE,
  });
  if (!row) throw new NotFoundError(`Remediation ${id} not found`);
  return { ...shape(row), allowedTransitions: ALLOWED_TRANSITIONS[row.status] };
}

export type RemediationWriteInput = {
  title: string;
  description: string;
  recommendation: string;
  severity?: RemediationSeverity;
  source?: FindingSource;
  ownerId?: number | null;
  dueAt?: Date | null;
  assetId?: number | null;
  vendorId?: number | null;
  threatId?: number | null;
  controlId?: number | null;
  identityId?: number | null;
  accessGrantId?: number | null;
};

/**
 * Every entity link is verified to belong to the caller's organisation before
 * it is stored. Without this a caller could attach their own finding to
 * another tenant's asset id and read the name back out of the detail
 * response — a cross-tenant leak through a write path rather than a read one.
 */
async function assertLinksInTenant(ctx: TenantContext, input: RemediationWriteInput) {
  const checks: Array<Promise<void>> = [];

  const check = async (
    id: number | null | undefined,
    find: () => Promise<{ id: number } | null>,
    label: string,
  ) => {
    if (id === null || id === undefined) return;
    const found = await find();
    if (!found) throw new NotFoundError(`${label} ${id} not found`);
  };

  checks.push(check(input.assetId, () => prisma.asset.findFirst({ where: { id: input.assetId!, ...scope(ctx) }, select: { id: true } }), "Asset"));
  checks.push(check(input.vendorId, () => prisma.vendor.findFirst({ where: { id: input.vendorId!, ...scope(ctx) }, select: { id: true } }), "Vendor"));
  checks.push(check(input.threatId, () => prisma.threat.findFirst({ where: { id: input.threatId!, ...scope(ctx) }, select: { id: true } }), "Threat"));
  checks.push(check(input.controlId, () => prisma.control.findFirst({ where: { id: input.controlId!, ...scope(ctx) }, select: { id: true } }), "Control"));
  checks.push(check(input.identityId, () => prisma.identity.findFirst({ where: { id: input.identityId!, ...scope(ctx) }, select: { id: true } }), "Identity"));
  checks.push(check(input.accessGrantId, () => prisma.accessGrant.findFirst({ where: { id: input.accessGrantId!, ...scope(ctx) }, select: { id: true } }), "Access grant"));

  // Owner must be a member of this organisation, not merely an existing user.
  if (input.ownerId !== null && input.ownerId !== undefined) {
    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: input.ownerId, organizationId: ctx.organizationId } },
      select: { id: true },
    });
    if (!member) {
      throw new NotFoundError(`User ${input.ownerId} is not a member of this organization`);
    }
  }

  await Promise.all(checks);
}

export async function createRemediation(ctx: TenantContext, input: RemediationWriteInput) {
  await assertLinksInTenant(ctx, input);
  return prisma.remediation.create({
    data: { ...input, organizationId: ctx.organizationId },
  });
}

export async function updateRemediation(
  ctx: TenantContext,
  id: number,
  input: Partial<RemediationWriteInput>,
) {
  const existing = await prisma.remediation.findFirst({ where: { id, ...scope(ctx) } });
  if (!existing) throw new NotFoundError(`Remediation ${id} not found`);
  await assertLinksInTenant(ctx, input as RemediationWriteInput);

  const after = await prisma.remediation.update({ where: { id }, data: input });
  return { before: existing, after };
}

/**
 * Moves work through its lifecycle.
 *
 * Resolving stamps `resolvedAt`; reopening clears it. Nothing else changes —
 * in particular no asset, control or threat is altered as a side effect. A
 * remediation records that someone says the work is done, which is a claim
 * about people, not a change to the estate.
 */
export async function transitionRemediation(
  ctx: TenantContext,
  id: number,
  to: RemediationStatus,
) {
  const existing = await prisma.remediation.findFirst({ where: { id, ...scope(ctx) } });
  if (!existing) throw new NotFoundError(`Remediation ${id} not found`);

  if (existing.status === to) throw new ConflictError(`Remediation ${id} is already ${to}`);
  if (!canTransition(existing.status, to)) {
    throw new ConflictError(
      `Cannot move remediation from ${existing.status} to ${to}. Allowed: ${ALLOWED_TRANSITIONS[existing.status].join(", ")}`,
    );
  }

  const closing = to === "RESOLVED" || to === "ACCEPTED";
  const after = await prisma.remediation.update({
    where: { id },
    data: { status: to, resolvedAt: closing ? new Date() : null },
  });

  return { before: existing, after };
}

export async function assignRemediation(
  ctx: TenantContext,
  id: number,
  ownerId: number | null,
) {
  const existing = await prisma.remediation.findFirst({ where: { id, ...scope(ctx) } });
  if (!existing) throw new NotFoundError(`Remediation ${id} not found`);
  await assertLinksInTenant(ctx, { ownerId } as RemediationWriteInput);

  const after = await prisma.remediation.update({ where: { id }, data: { ownerId } });
  return { before: existing, after };
}
