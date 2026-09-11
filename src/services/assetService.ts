import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../lib/errors.js";

/** The most recent Risk row per asset is the asset's "current" risk. */
const latestRisk = {
  orderBy: { computedAt: "desc" },
  take: 1,
} as const;

/**
 * Every asset with its current risk score and band, for the asset inventory
 * table. Assets that have never been assessed come back with risk: null
 * rather than being dropped.
 */
export async function listAssets() {
  const assets = await prisma.asset.findMany({
    orderBy: { name: "asc" },
    include: { risks: latestRisk },
  });

  return assets.map((asset) => {
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
      risk: risk ? { score: risk.score, band: risk.band, computedAt: risk.computedAt } : null,
    };
  });
}

/** One asset, its PHI categories, and the full four-factor risk breakdown. */
export async function getAssetById(id: number) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    include: {
      phiTypes: { include: { phiType: true } },
      risks: latestRisk,
      outboundFlows: { include: { targetAsset: { select: { name: true } } } },
      inboundFlows: { include: { sourceAsset: { select: { name: true } } } },
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
        to: f.targetAsset.name,
        recordsPerDay: f.recordsPerDay,
        encrypted: f.encrypted,
      })),
      inbound: asset.inboundFlows.map((f) => ({
        from: f.sourceAsset.name,
        recordsPerDay: f.recordsPerDay,
        encrypted: f.encrypted,
      })),
    },
  };
}
