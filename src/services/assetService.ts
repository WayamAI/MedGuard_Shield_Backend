import type { AssetType, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { flowStatus } from "./flowStatus.js";

/**
 * Asset inventory.
 *
 * Every query is scoped through `scope(ctx)`, and every single-record lookup
 * uses `findFirst` with that scope rather than `findUnique` by id — a
 * `findUnique` would return another tenant's row perfectly happily.
 */

export type AssetListFilters = {
  search?: string;
  type?: AssetType;
  band?: string;
  includeArchived?: boolean;
  sort?: "name" | "phiVolume" | "riskScore" | "createdAt";
  order?: "asc" | "desc";
};

function listWhere(ctx: TenantContext, filters: AssetListFilters): Prisma.AssetWhereInput {
  return {
    ...scope(ctx),
    // Archived assets are hidden by default but never deleted; the inventory
    // is a record of what held PHI, not only of what still does.
    ...(filters.includeArchived ? {} : { archivedAt: null }),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.search
      ? { name: { contains: filters.search, mode: "insensitive" as const } }
      : {}),
    ...(filters.band ? { risks: { some: { band: filters.band as never } } } : {}),
  };
}

/**
 * Sorting by risk score cannot be expressed as a Prisma `orderBy` across the
 * one-to-one Risk relation together with nulls-last semantics, so it is done
 * in memory *after* the page is fetched. That is a deliberate, bounded
 * compromise: it sorts within the page rather than across the whole set.
 * Callers wanting a true risk ranking should page `/api/risks`, which is
 * ordered by score in SQL.
 */
function orderByFor(filters: AssetListFilters): Prisma.AssetOrderByWithRelationInput {
  const order = filters.order ?? "asc";
  switch (filters.sort) {
    case "phiVolume":
      return { phiVolume: order };
    case "createdAt":
      return { createdAt: order };
    case "riskScore":
    case "name":
    default:
      return { name: order };
  }
}

export type AssetListItem = {
  id: number;
  name: string;
  type: AssetType;
  phiVolume: number;
  encrypted: boolean;
  mfaEnabled: boolean;
  lastAssessedAt: Date | null;
  createdAt: Date;
  archivedAt: Date | null;
  risk: { score: number; band: string; computedAt: Date } | null;
  counts: { phiTypes: number; flows: number; accessGrants: number; openThreats: number; controls: number };
};

/**
 * Every asset with its current risk and relationship counts.
 *
 * The counts come from Prisma `_count`, which is a single grouped query rather
 * than one per asset — the shape the previous implementation would have
 * degraded into had the UI needed them.
 */
export async function listAssets(
  ctx: TenantContext,
  filters: AssetListFilters = {},
  page: { skip?: number; take?: number } = {},
): Promise<{ items: AssetListItem[]; total: number }> {
  const where = listWhere(ctx, filters);

  const [rows, total] = await Promise.all([
    prisma.asset.findMany({
      where,
      orderBy: orderByFor(filters),
      skip: page.skip,
      take: page.take,
      include: {
        risks: { select: { score: true, band: true, computedAt: true } },
        _count: {
          select: {
            phiTypes: true,
            outboundFlows: true,
            inboundFlows: true,
            accessGrants: true,
            controls: true,
            threats: { where: { status: { in: ["OPEN", "INVESTIGATING"] } } },
          },
        },
      },
    }),
    prisma.asset.count({ where }),
  ]);

  const items = rows.map((asset) => {
    const risk = asset.risks[0];
    return {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      phiVolume: asset.phiVolume,
      encrypted: asset.encrypted,
      mfaEnabled: asset.mfaEnabled,
      lastAssessedAt: asset.lastAssessedAt,
      createdAt: asset.createdAt,
      archivedAt: asset.archivedAt,
      risk: risk ? { score: risk.score, band: risk.band, computedAt: risk.computedAt } : null,
      counts: {
        phiTypes: asset._count.phiTypes,
        flows: asset._count.outboundFlows + asset._count.inboundFlows,
        accessGrants: asset._count.accessGrants,
        openThreats: asset._count.threats,
        controls: asset._count.controls,
      },
    };
  });

  if (filters.sort === "riskScore") {
    const dir = filters.order === "desc" ? -1 : 1;
    // Unassessed assets sort last in both directions: "no score" is not a low
    // score, and burying them at the top of an ascending list would read as if
    // they were the safest things in the estate.
    items.sort((a, b) => {
      if (!a.risk && !b.risk) return 0;
      if (!a.risk) return 1;
      if (!b.risk) return -1;
      return (a.risk.score - b.risk.score) * dir;
    });
  }

  return { items, total };
}

/**
 * One asset and everything attached to it: PHI categories, the four-factor
 * risk breakdown, flows both ways, the vendors that can reach it, who has
 * access, open threats, applied controls and outstanding remediation.
 *
 * This is one query with nested selects rather than nine round trips. Each
 * child list is bounded by `take` so a pathological asset cannot return an
 * unbounded document.
 */
export async function getAssetById(ctx: TenantContext, id: number) {
  const asset = await prisma.asset.findFirst({
    where: { id, ...scope(ctx) },
    include: {
      phiTypes: { include: { phiType: true } },
      risks: true,
      outboundFlows: {
        take: 100,
        include: { targetAsset: { select: { id: true, name: true, mfaEnabled: true } }, phiType: { select: { name: true } } },
      },
      inboundFlows: {
        take: 100,
        include: { sourceAsset: { select: { id: true, name: true } }, phiType: { select: { name: true } } },
      },
      vendorAccess: {
        take: 100,
        include: { vendor: { select: { id: true, name: true, baaStatus: true } } },
      },
      accessGrants: {
        take: 100,
        where: { revokedAt: null },
        include: { identity: { select: { id: true, displayName: true, kind: true, active: true, mfaEnabled: true } } },
      },
      threats: { take: 100, orderBy: { detectedAt: "desc" } },
      controls: { include: { control: true } },
      remediations: {
        take: 100,
        where: { status: { not: "RESOLVED" } },
        orderBy: { severity: "desc" },
      },
    },
  });

  if (!asset) throw new NotFoundError(`Asset ${id} not found`);

  const risk = asset.risks[0];

  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    phiVolume: asset.phiVolume,
    encrypted: asset.encrypted,
    mfaEnabled: asset.mfaEnabled,
    lastAssessedAt: asset.lastAssessedAt,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    archivedAt: asset.archivedAt,

    phiTypes: asset.phiTypes.map((link) => ({
      id: link.phiType.id,
      name: link.phiType.name,
      sensitivity: link.phiType.sensitivity,
      recordsPerDay: link.recordsPerDay,
    })),

    risk: risk
      ? {
          id: risk.id,
          likelihood: risk.likelihood,
          impact: risk.impact,
          exposure: risk.exposure,
          controlGap: risk.controlGap,
          score: risk.score,
          band: risk.band,
          computedAt: risk.computedAt,
        }
      : null,

    flows: {
      outbound: asset.outboundFlows.map((f) => ({
        id: f.id,
        to: f.targetAsset.name,
        toAssetId: f.targetAsset.id,
        phiType: f.phiType.name,
        recordsPerDay: f.recordsPerDay,
        encrypted: f.encrypted,
        status: flowStatus(f.encrypted, f.targetAsset.mfaEnabled),
      })),
      inbound: asset.inboundFlows.map((f) => ({
        id: f.id,
        from: f.sourceAsset.name,
        fromAssetId: f.sourceAsset.id,
        phiType: f.phiType.name,
        recordsPerDay: f.recordsPerDay,
        encrypted: f.encrypted,
      })),
    },

    vendors: asset.vendorAccess.map((v) => ({
      id: v.vendor.id,
      name: v.vendor.name,
      baaStatus: v.vendor.baaStatus,
      grantedAt: v.grantedAt,
    })),

    access: asset.accessGrants.map((g) => ({
      id: g.id,
      identityId: g.identity.id,
      identityName: g.identity.displayName,
      kind: g.identity.kind,
      active: g.identity.active,
      mfaEnabled: g.identity.mfaEnabled,
      level: g.level,
      grantedAt: g.grantedAt,
      lastUsedAt: g.lastUsedAt,
    })),

    threats: asset.threats.map((t) => ({
      id: t.id,
      severity: t.severity,
      status: t.status,
      title: t.title,
      detectedAt: t.detectedAt,
      resolvedAt: t.resolvedAt,
    })),

    controls: asset.controls.map((c) => ({
      id: c.control.id,
      name: c.control.name,
      category: c.control.category,
      status: c.control.status,
      effectiveness: c.control.effectiveness,
      lastReviewedAt: c.control.lastReviewedAt,
    })),

    remediations: asset.remediations.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      status: r.status,
      dueAt: r.dueAt,
    })),
  };
}

export type AssetWriteInput = {
  name: string;
  type: AssetType;
  phiVolume?: number;
  encrypted?: boolean;
  mfaEnabled?: boolean;
  lastAssessedAt?: Date | null;
};

/**
 * Creates an asset.
 *
 * The duplicate check is now the database's, not a read-then-write: name is
 * unique per organisation, and P2002 is translated to a 409. The previous
 * pre-check had a window where two concurrent creates both passed it and the
 * loser surfaced as a 500.
 */
export async function createAsset(ctx: TenantContext, input: AssetWriteInput) {
  try {
    return await prisma.asset.create({
      data: { ...input, organizationId: ctx.organizationId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`An asset named "${input.name}" already exists`);
    }
    throw err;
  }
}

/** Prisma's unique-constraint code, the one the old comment claimed to handle. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** Partial update. Absent fields are left alone rather than nulled. */
export async function updateAsset(
  ctx: TenantContext,
  id: number,
  input: Partial<AssetWriteInput>,
) {
  const asset = await prisma.asset.findFirst({ where: { id, ...scope(ctx) } });
  if (!asset) throw new NotFoundError(`Asset ${id} not found`);

  try {
    const updated = await prisma.asset.update({ where: { id }, data: input });
    return { before: asset, after: updated };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`An asset named "${input.name}" already exists`);
    }
    throw err;
  }
}

/**
 * Archive, not delete.
 *
 * An asset that held PHI stays part of the compliance record after it is
 * decommissioned — its past threats, access grants and risk history are
 * evidence, and cascading them away on a DELETE would destroy exactly what an
 * auditor asks for. Nothing in this codebase hard-deletes an asset.
 */
export async function archiveAsset(ctx: TenantContext, id: number) {
  const asset = await prisma.asset.findFirst({ where: { id, ...scope(ctx) } });
  if (!asset) throw new NotFoundError(`Asset ${id} not found`);
  if (asset.archivedAt) throw new ConflictError(`Asset ${id} is already archived`);

  return prisma.asset.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function restoreAsset(ctx: TenantContext, id: number) {
  const asset = await prisma.asset.findFirst({ where: { id, ...scope(ctx) } });
  if (!asset) throw new NotFoundError(`Asset ${id} not found`);
  if (!asset.archivedAt) throw new ConflictError(`Asset ${id} is not archived`);

  return prisma.asset.update({ where: { id }, data: { archivedAt: null } });
}
