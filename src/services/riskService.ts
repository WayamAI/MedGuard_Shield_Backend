import { prisma } from "../lib/prisma.js";

/**
 * Risk records shaped for the likelihood x impact matrix: the two axes, the
 * band that colours the cell, and the asset name that labels the chip.
 */
export async function listRisks() {
  const risks = await prisma.risk.findMany({
    orderBy: [{ score: "desc" }],
    include: { asset: { select: { name: true } } },
  });

  return risks.map((risk) => ({
    id: risk.id,
    assetId: risk.assetId,
    assetName: risk.asset.name,
    likelihood: risk.likelihood,
    impact: risk.impact,
    exposure: risk.exposure,
    controlGap: risk.controlGap,
    score: risk.score,
    band: risk.band,
    computedAt: risk.computedAt,
  }));
}
