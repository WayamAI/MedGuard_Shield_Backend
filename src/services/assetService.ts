import type { AssetType } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

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

export type AssetWriteInput = {
  name: string;
  type: AssetType;
  phiVolume?: number;
  encrypted?: boolean;
  mfaEnabled?: boolean;
  lastAssessedAt?: Date | null;
};

/**
 * Creates an asset. Name is unique in the schema, so a duplicate surfaces as
 * Prisma's P2002 -- translated to a 409 here rather than leaking as a 500,
 * because "that name is taken" is a client problem, not a server fault.
 */
export async function createAsset(input: AssetWriteInput) {
  const existing = await prisma.asset.findUnique({ where: { name: input.name } });
  if (existing) throw new ConflictError(`An asset named "${input.name}" already exists`);

  return prisma.asset.create({ data: input });
}

/** Partial update. Absent fields are left alone rather than nulled. */
export async function updateAsset(id: number, input: Partial<AssetWriteInput>) {
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset) throw new NotFoundError(`Asset ${id} not found`);

  if (input.name && input.name !== asset.name) {
    const clash = await prisma.asset.findUnique({ where: { name: input.name } });
    if (clash) throw new ConflictError(`An asset named "${input.name}" already exists`);
  }

  return prisma.asset.update({ where: { id }, data: input });
}
