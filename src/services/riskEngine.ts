import type { Prisma, RiskBand, RiskChangeReason } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
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
 * Risk persistence.
 *
 * The formula is unchanged and deliberately so: score = l × i × e × c / 625 ×
 * 100, five bands. What changed is that a score now has a history and a
 * reason.
 *
 * Every write goes through `applyRisk`, which is the only place a Risk row is
 * created or updated. It records the before/after pair into RiskHistory in the
 * same transaction, so a score cannot move without leaving a trace.
 *
 * `reason` is supplied by the caller that made the change and is drawn from a
 * fixed enum of things the system actually observes. There is no free-text
 * explanation field: a narrative the backend cannot substantiate would be
 * worse than none, so the UI composes its wording from `reason` plus the
 * recorded field deltas.
 */

export type AssessmentInputs = {
  likelihood: number;
  impact: number;
  exposure: number;
  controlGap: number;
};

export type RiskSnapshot = {
  id: number;
  assetId: number;
  assetName: string;
  likelihood: number;
  impact: number;
  exposure: number;
  controlGap: number;
  score: number;
  band: RiskBand;
  computedAt: Date;
  previous: { score: number; band: RiskBand } | null;
  /** Whether this call actually moved the number. */
  changed: boolean;
};

/** Scoped asset lookup. Never `findUnique` by id alone — see lib/tenant.ts. */
async function requireAsset(
  ctx: TenantContext,
  assetId: number,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const asset = await db.asset.findFirst({
    where: { id: assetId, ...scope(ctx) },
    select: { id: true, name: true },
  });
  if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);
  return asset;
}

/**
 * Writes an assessment and its history entry atomically.
 *
 * Upserts rather than inserts: Risk now carries a unique constraint on
 * assetId, so "the asset's risk" is one row whose movement lives in
 * RiskHistory. Before this, recompute overwrote in place and the previous
 * score existed only in the HTTP response.
 */
async function applyRisk(
  ctx: TenantContext,
  assetId: number,
  inputs: AssessmentInputs,
  reason: RiskChangeReason,
): Promise<RiskSnapshot> {
  const { score, band } = computeRisk(
    inputs.likelihood,
    inputs.impact,
    inputs.exposure,
    inputs.controlGap,
  );

  return prisma.$transaction(async (tx) => {
    const asset = await requireAsset(ctx, assetId, tx);
    const existing = await tx.risk.findUnique({ where: { assetId } });

    const previous = existing ? { score: existing.score, band: existing.band } : null;
    const changed =
      !existing ||
      existing.score !== score ||
      existing.band !== band ||
      existing.likelihood !== inputs.likelihood ||
      existing.impact !== inputs.impact ||
      existing.exposure !== inputs.exposure ||
      existing.controlGap !== inputs.controlGap;

    const risk = await tx.risk.upsert({
      where: { assetId },
      create: {
        organizationId: ctx.organizationId,
        assetId,
        ...inputs,
        score,
        band,
        computedAt: new Date(),
      },
      update: { ...inputs, score, band, computedAt: new Date() },
    });

    // A recompute that moved nothing is not history. Recording it would bury
    // the changes that matter under rows saying "still 100".
    if (changed) {
      await tx.riskHistory.create({
        data: {
          organizationId: ctx.organizationId,
          riskId: risk.id,
          assetId,
          previousScore: previous?.score ?? null,
          previousBand: previous?.band ?? null,
          score,
          band,
          ...inputs,
          reason,
          changedById: ctx.userId,
        },
      });
    }

    return {
      id: risk.id,
      assetId,
      assetName: asset.name,
      likelihood: risk.likelihood,
      impact: risk.impact,
      exposure: risk.exposure,
      controlGap: risk.controlGap,
      score: risk.score,
      band: risk.band,
      computedAt: risk.computedAt,
      previous,
      changed,
    };
  });
}

/**
 * Records an assessor's judgement. This is the path that was missing: before
 * it, the four 1-5 inputs could only enter the system by CSV import, so an
 * assessor using the product could not record an assessment at all.
 */
export async function assessAsset(
  ctx: TenantContext,
  assetId: number,
  inputs: AssessmentInputs,
): Promise<RiskSnapshot> {
  const existing = await prisma.risk.findUnique({ where: { assetId } });
  return applyRisk(
    ctx,
    assetId,
    inputs,
    existing ? "MANUAL_ASSESSMENT" : "INITIAL_ASSESSMENT",
  );
}

/**
 * Re-scores an asset from the inputs currently stored against it.
 *
 * Still 404s when no assessment exists — recompute derives from stored
 * judgement and has nothing to derive from otherwise. `POST
 * /api/assets/:id/assessment` is the way to create the first one.
 */
export async function recomputeAssetRisk(
  ctx: TenantContext,
  assetId: number,
): Promise<RiskSnapshot> {
  await requireAsset(ctx, assetId);

  const risk = await prisma.risk.findUnique({ where: { assetId } });
  if (!risk) {
    throw new NotFoundError(
      `No risk assessment exists for asset ${assetId}. Create one with POST /api/assets/${assetId}/assessment.`,
    );
  }

  return applyRisk(
    ctx,
    assetId,
    {
      likelihood: risk.likelihood,
      impact: risk.impact,
      exposure: risk.exposure,
      controlGap: risk.controlGap,
    },
    "RECOMPUTE",
  );
}

/** Used by the import path, which supplies its own reason. */
export async function applyImportedAssessment(
  ctx: TenantContext,
  assetId: number,
  inputs: AssessmentInputs,
): Promise<RiskSnapshot> {
  return applyRisk(ctx, assetId, inputs, "IMPORTED");
}

export type RiskHistoryEntry = {
  id: number;
  assetId: number;
  assetName: string;
  previousScore: number | null;
  previousBand: RiskBand | null;
  score: number;
  band: RiskBand;
  delta: number | null;
  likelihood: number;
  impact: number;
  exposure: number;
  controlGap: number;
  reason: RiskChangeReason;
  changedBy: { id: number; email: string } | null;
  changedAt: Date;
};

/**
 * Movement over time, newest first. `delta` is precomputed server-side so the
 * chart and the "65 → 72" label agree without the client re-deriving it.
 */
export async function listRiskHistory(
  ctx: TenantContext,
  options: { assetId?: number; skip?: number; take?: number } = {},
): Promise<{ entries: RiskHistoryEntry[]; total: number }> {
  const where = {
    ...scope(ctx),
    ...(options.assetId !== undefined ? { assetId: options.assetId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.riskHistory.findMany({
      where,
      orderBy: { changedAt: "desc" },
      skip: options.skip,
      take: options.take,
      include: {
        asset: { select: { name: true } },
        changedBy: { select: { id: true, email: true } },
      },
    }),
    prisma.riskHistory.count({ where }),
  ]);

  return {
    total,
    entries: rows.map((r) => ({
      id: r.id,
      assetId: r.assetId,
      assetName: r.asset.name,
      previousScore: r.previousScore,
      previousBand: r.previousBand,
      score: r.score,
      band: r.band,
      delta:
        r.previousScore === null
          ? null
          : Math.round((r.score - r.previousScore) * 100) / 100,
      likelihood: r.likelihood,
      impact: r.impact,
      exposure: r.exposure,
      controlGap: r.controlGap,
      reason: r.reason,
      changedBy: r.changedBy ? { id: r.changedBy.id, email: r.changedBy.email } : null,
      changedAt: r.changedAt,
    })),
  };
}
