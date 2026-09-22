import type { BaaStatus, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { isUniqueViolation } from "./assetService.js";

/** Vendors are expected to be reassessed annually. */
const ASSESSMENT_INTERVAL_DAYS = 365;

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function assessmentOverdue(lastAssessedAt: Date | null): boolean {
  const days = daysSince(lastAssessedAt);
  return days === null || days > ASSESSMENT_INTERVAL_DAYS;
}

export type VendorListFilters = {
  search?: string;
  baaStatus?: BaaStatus;
  includeArchived?: boolean;
  sort?: "name" | "phiVolume" | "createdAt";
  order?: "asc" | "desc";
};

function listWhere(ctx: TenantContext, filters: VendorListFilters): Prisma.VendorWhereInput {
  return {
    ...scope(ctx),
    ...(filters.includeArchived ? {} : { archivedAt: null }),
    ...(filters.baaStatus ? { baaStatus: filters.baaStatus } : {}),
    ...(filters.search
      ? { name: { contains: filters.search, mode: "insensitive" as const } }
      : {}),
  };
}

export async function listVendors(
  ctx: TenantContext,
  filters: VendorListFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where = listWhere(ctx, filters);

  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: { [filters.sort ?? "name"]: filters.order ?? "asc" },
      skip: page.skip,
      take: page.take,
      include: {
        risks: { select: { score: true, band: true, computedAt: true } },
        assetAccess: { include: { asset: { select: { name: true } } } },
        _count: { select: { remediations: true } },
      },
    }),
    prisma.vendor.count({ where }),
  ]);

  return {
    total,
    items: vendors.map((v) => {
      const risk = v.risks[0];
      return {
        id: v.id,
        name: v.name,
        baaStatus: v.baaStatus,
        phiVolume: v.phiVolume,
        lastAssessedAt: v.lastAssessedAt,
        archivedAt: v.archivedAt,
        daysSinceAssessment: daysSince(v.lastAssessedAt),
        assessmentOverdue: assessmentOverdue(v.lastAssessedAt),
        baaCompliant: v.baaStatus === "SIGNED",
        assetCount: v.assetAccess.length,
        assets: v.assetAccess.map((a) => a.asset.name),
        openRemediations: v._count.remediations,
        risk: risk ? { score: risk.score, band: risk.band, computedAt: risk.computedAt } : null,
      };
    }),
  };
}

export async function getVendorById(ctx: TenantContext, id: number) {
  const v = await prisma.vendor.findFirst({
    where: { id, ...scope(ctx) },
    include: {
      risks: true,
      assetAccess: {
        include: {
          asset: {
            select: { id: true, name: true, type: true, encrypted: true, phiVolume: true },
          },
        },
      },
      remediations: {
        take: 100,
        where: { status: { not: "RESOLVED" } },
        orderBy: { severity: "desc" },
      },
    },
  });

  if (!v) throw new NotFoundError(`Vendor ${id} not found`);

  const risk = v.risks[0];

  return {
    id: v.id,
    name: v.name,
    baaStatus: v.baaStatus,
    phiVolume: v.phiVolume,
    lastAssessedAt: v.lastAssessedAt,
    daysSinceAssessment: daysSince(v.lastAssessedAt),
    assessmentOverdue: assessmentOverdue(v.lastAssessedAt),
    baaCompliant: v.baaStatus === "SIGNED",
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    archivedAt: v.archivedAt,

    assets: v.assetAccess.map((a) => ({
      id: a.asset.id,
      name: a.asset.name,
      type: a.asset.type,
      encrypted: a.asset.encrypted,
      phiVolume: a.asset.phiVolume,
      grantedAt: a.grantedAt,
    })),

    /** Total PHI reachable through the assets this vendor can touch. */
    phiExposure: v.assetAccess.reduce((sum, a) => sum + a.asset.phiVolume, 0),

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

    remediations: v.remediations.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      status: r.status,
      dueAt: r.dueAt,
    })),
  };
}

export type VendorWriteInput = {
  name: string;
  baaStatus?: BaaStatus;
  phiVolume?: number;
  lastAssessedAt?: Date | null;
};

export async function createVendor(ctx: TenantContext, input: VendorWriteInput) {
  try {
    return await prisma.vendor.create({
      data: { ...input, organizationId: ctx.organizationId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A vendor named "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function updateVendor(
  ctx: TenantContext,
  id: number,
  input: Partial<VendorWriteInput>,
) {
  const vendor = await prisma.vendor.findFirst({ where: { id, ...scope(ctx) } });
  if (!vendor) throw new NotFoundError(`Vendor ${id} not found`);

  try {
    const updated = await prisma.vendor.update({ where: { id }, data: input });
    return { before: vendor, after: updated };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A vendor named "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function archiveVendor(ctx: TenantContext, id: number) {
  const vendor = await prisma.vendor.findFirst({
    where: { id, ...scope(ctx) },
    include: { _count: { select: { assetAccess: true } } },
  });
  if (!vendor) throw new NotFoundError(`Vendor ${id} not found`);
  if (vendor.archivedAt) throw new ConflictError(`Vendor ${id} is already archived`);

  // A vendor that can still reach PHI is not something to quietly file away.
  // Refusing here forces the access to be removed first, which is the action
  // that actually reduces exposure.
  if (vendor._count.assetAccess > 0) {
    throw new ConflictError(
      `Vendor ${id} still has access to ${vendor._count.assetAccess} asset(s). Remove that access before archiving.`,
    );
  }

  return prisma.vendor.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function restoreVendor(ctx: TenantContext, id: number) {
  const vendor = await prisma.vendor.findFirst({ where: { id, ...scope(ctx) } });
  if (!vendor) throw new NotFoundError(`Vendor ${id} not found`);
  if (!vendor.archivedAt) throw new ConflictError(`Vendor ${id} is not archived`);

  return prisma.vendor.update({ where: { id }, data: { archivedAt: null } });
}

/**
 * Vendor risk assessment and recomputation live in riskEngine.ts.
 *
 * They used to live here, with their own `computeRisk` call and their own
 * upsert -- a second implementation of the same formula that had to be kept in
 * step by hand. There is one risk engine; this is not it. Routes import
 * `assessVendor` and `recomputeVendorRisk` from riskEngine directly.
 */

/** Grants or removes a vendor's reach into an asset. */
export async function setVendorAssetAccess(
  ctx: TenantContext,
  vendorId: number,
  assetId: number,
  granted: boolean,
) {
  const [vendor, asset] = await Promise.all([
    prisma.vendor.findFirst({ where: { id: vendorId, ...scope(ctx) }, select: { id: true } }),
    prisma.asset.findFirst({ where: { id: assetId, ...scope(ctx) }, select: { id: true } }),
  ]);
  if (!vendor) throw new NotFoundError(`Vendor ${vendorId} not found`);
  if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);

  if (granted) {
    await prisma.vendorAssetAccess.upsert({
      where: { vendorId_assetId: { vendorId, assetId } },
      create: { vendorId, assetId },
      update: {},
    });
  } else {
    await prisma.vendorAssetAccess.deleteMany({ where: { vendorId, assetId } });
  }

  return { vendorId, assetId, granted };
}
