import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../lib/errors.js";
import { computeRisk } from "./riskScoring.js";

// The scoring maths lives in riskScoring.ts (no DB import, so it unit-tests
// without a database). Re-exported here so riskEngine stays the single entry
// point callers import from.
export {
  bandForScore,
  computeRisk,
  MAX_RAW_SCORE,
  type RiskInputs,
  type RiskResult,
} from "./riskScoring.js";

/**
 * Re-scores an asset from the inputs currently stored against it and persists
 * the result. Used by POST /api/risks/:assetId/recompute after an assessor
 * edits the 1-5 judgements.
 */
export async function recomputeAssetRisk(assetId: number) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, name: true },
  });
  if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);

  const risk = await prisma.risk.findFirst({
    where: { assetId },
    orderBy: { computedAt: "desc" },
  });
  if (!risk) throw new NotFoundError(`No risk record exists for asset ${assetId}`);

  const { score, band } = computeRisk(
    risk.likelihood,
    risk.impact,
    risk.exposure,
    risk.controlGap,
  );

  const updated = await prisma.risk.update({
    where: { id: risk.id },
    data: { score, band, computedAt: new Date() },
  });

  return {
    id: updated.id,
    assetId: updated.assetId,
    assetName: asset.name,
    likelihood: updated.likelihood,
    impact: updated.impact,
    exposure: updated.exposure,
    controlGap: updated.controlGap,
    score: updated.score,
    band: updated.band,
    computedAt: updated.computedAt,
    previous: { score: risk.score, band: risk.band },
  };
}
