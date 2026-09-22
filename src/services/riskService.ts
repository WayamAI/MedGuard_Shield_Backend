import type { Prisma, RiskBand } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { scope, type TenantContext } from "../lib/tenant.js";

/**
 * Risk records shaped for the likelihood x impact matrix: the two axes, the
 * band that colours the cell, and the asset name that labels the chip.
 */
export type RiskListFilters = { band?: RiskBand; assetId?: number };

export async function listRisks(
  ctx: TenantContext,
  filters: RiskListFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where: Prisma.RiskWhereInput = {
    ...scope(ctx),
    ...(filters.band ? { band: filters.band } : {}),
    ...(filters.assetId ? { assetId: filters.assetId } : {}),
  };

  const [risks, total] = await Promise.all([
    prisma.risk.findMany({
      where,
      orderBy: [{ score: "desc" }],
      skip: page.skip,
      take: page.take,
      include: { asset: { select: { name: true, type: true, archivedAt: true } } },
    }),
    prisma.risk.count({ where }),
  ]);

  return {
    total,
    items: risks.map((risk) => ({
      id: risk.id,
      assetId: risk.assetId,
      assetName: risk.asset.name,
      assetType: risk.asset.type,
      assetArchived: risk.asset.archivedAt !== null,
      likelihood: risk.likelihood,
      impact: risk.impact,
      exposure: risk.exposure,
      controlGap: risk.controlGap,
      score: risk.score,
      band: risk.band,
      computedAt: risk.computedAt,
    })),
  };
}

/** Band distribution for the dashboard, counted in SQL rather than in JS. */
export async function riskDistribution(ctx: TenantContext) {
  const grouped = await prisma.risk.groupBy({
    by: ["band"],
    where: scope(ctx),
    _count: { _all: true },
  });

  const bands: Record<string, number> = {
    LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0, EXTREME: 0,
  };
  for (const row of grouped) bands[row.band] = row._count._all;

  return bands;
}
