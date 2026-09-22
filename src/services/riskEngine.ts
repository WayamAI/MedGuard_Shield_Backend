import type { Prisma, RiskBand, RiskChangeReason, RiskSubject } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { computeRisk } from "./riskScoring.js";
import {
  deriveAssetExposure, deriveControlGap, deriveVendorControlGap, deriveVendorExposure,
  explain, type DerivedFactor,
} from "./riskFactors.js";

// The scoring maths lives in riskScoring.ts (no DB import, so it unit-tests
// without a database) and the factor derivation in riskFactors.ts. Both are
// re-exported here so riskEngine stays the single entry point callers import
// from -- there is one risk engine, and this is it.
export {
  bandForScore, computeRisk, MAX_RAW_SCORE,
  type RiskInputs, type RiskResult,
} from "./riskScoring.js";
export * from "./riskFactors.js";

/**
 * The single authority for risk.
 *
 * Nothing else in the codebase computes a score, writes a Risk row, or writes
 * a RiskHistory row. Services that change something risk-relevant call
 * `recalculateAsset` / `recalculateVendor` and let this module decide whether
 * anything actually moved.
 *
 * ## The split
 *
 * `likelihood` and `impact` are assessor judgement and are only ever set by an
 * explicit assessment. `exposure` and `controlGap` are derived from recorded
 * facts (see riskFactors.ts) and are recomputed automatically -- unless an
 * assessor has pinned them, in which case their judgement wins and the
 * derivation leaves that factor alone.
 *
 * ## No recursion
 *
 * Recalculation only ever *reads* the graph and writes Risk, RiskHistory and
 * an audit row. It never mutates an asset, vendor, control, grant or threat,
 * so it cannot trigger itself. That invariant is what makes it safe to call
 * from inside any mutation.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type AssessmentInputs = {
  likelihood: number;
  impact: number;
  /** Optional. Supplying it pins the factor against automatic derivation. */
  exposure?: number;
  /** Optional. Supplying it pins the factor against automatic derivation. */
  controlGap?: number;
};

export type RiskSnapshot = {
  id: number;
  subjectType: RiskSubject;
  subjectId: number;
  subjectName: string;
  /**
   * Subject-specific aliases for `subjectId` / `subjectName`, populated only
   * for the matching kind.
   *
   * The generic pair is the honest shape now that assets and vendors share one
   * engine, but `assetId` and `vendorName` were in the published contract and
   * the frontend reads them. Keeping both costs four fields and avoids a
   * breaking change for no gain.
   */
  assetId: number | null;
  assetName: string | null;
  vendorId: number | null;
  vendorName: string | null;
  likelihood: number;
  impact: number;
  exposure: number;
  controlGap: number;
  exposureOverridden: boolean;
  controlGapOverridden: boolean;
  score: number;
  band: RiskBand;
  computedAt: Date;
  previous: { score: number; band: RiskBand } | null;
  /** Whether this call actually moved anything. */
  changed: boolean;
  /** Why the derived factors landed where they did. Empty when both are pinned. */
  derivation: string | null;
};

// ------------------------------------------------------------ derivation

/**
 * Gathers the facts an asset's derived factors depend on, in one query, and
 * runs the pure rules over them.
 */
async function deriveForAsset(db: Db, assetId: number) {
  const asset = await db.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true, name: true, phiVolume: true, encrypted: true, mfaEnabled: true,
      accessGrants: { where: { revokedAt: null }, select: { level: true } },
      vendorAccess: { select: { vendorId: true } },
      outboundFlows: { where: { encrypted: false }, select: { id: true } },
      threats: {
        where: { status: { in: ["OPEN", "INVESTIGATING"] }, severity: { in: ["HIGH", "CRITICAL"] } },
        select: { id: true },
      },
      controls: { select: { control: { select: { status: true, effectiveness: true } } } },
    },
  });
  if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);

  const applied = asset.controls.map((c) => c.control);

  return {
    name: asset.name,
    exposure: deriveAssetExposure({
      phiVolume: asset.phiVolume,
      encrypted: asset.encrypted,
      mfaEnabled: asset.mfaEnabled,
      liveGrants: asset.accessGrants.length,
      elevatedGrants: asset.accessGrants.filter((g) => g.level !== "READ").length,
      vendorCount: asset.vendorAccess.length,
      unencryptedOutboundFlows: asset.outboundFlows.length,
      openSevereThreats: asset.threats.length,
    }),
    controlGap: deriveControlGap({
      effective: applied.filter(
        (c) => c.status === "IMPLEMENTED" && c.effectiveness === "EFFECTIVE",
      ).length,
      partial: applied.filter(
        (c) => c.effectiveness === "PARTIALLY_EFFECTIVE" || c.status === "PARTIAL",
      ).length,
    }),
  };
}

const ASSESSMENT_INTERVAL_DAYS = 365;

async function deriveForVendor(db: Db, vendorId: number) {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true, name: true, baaStatus: true, lastAssessedAt: true,
      assetAccess: { select: { asset: { select: { phiVolume: true, encrypted: true } } } },
    },
  });
  if (!vendor) throw new NotFoundError(`Vendor ${vendorId} not found`);

  const assets = vendor.assetAccess.map((a) => a.asset);
  const overdue =
    vendor.lastAssessedAt === null ||
    (Date.now() - vendor.lastAssessedAt.getTime()) / 86_400_000 > ASSESSMENT_INTERVAL_DAYS;

  return {
    name: vendor.name,
    exposure: deriveVendorExposure({
      reachablePhi: assets.reduce((sum, a) => sum + a.phiVolume, 0),
      assetCount: assets.length,
      unencryptedAssets: assets.filter((a) => !a.encrypted).length,
    }),
    controlGap: deriveVendorControlGap({
      baaStatus: vendor.baaStatus,
      assessmentOverdue: overdue,
    }),
  };
}

function derivationSummary(
  exposure: DerivedFactor | null,
  controlGap: DerivedFactor | null,
): string | null {
  const parts: string[] = [];
  if (exposure) parts.push(`exposure ${exposure.value} (${explain(exposure)})`);
  if (controlGap) parts.push(`control gap ${controlGap.value} (${explain(controlGap)})`);
  return parts.length > 0 ? parts.join(" | ") : null;
}

// --------------------------------------------------------------- writing

type ApplyArgs = {
  subjectType: RiskSubject;
  subjectId: number;
  reason: RiskChangeReason;
  /** Present on an explicit assessment; absent on an automatic recalculation. */
  assessment?: AssessmentInputs;
};

/**
 * The only writer of Risk, VendorRisk and RiskHistory.
 *
 * Takes a db client rather than opening its own transaction, so a caller
 * already inside one can pass it and have the mutation, the rescore, the
 * history row and the audit row commit together.
 */
async function apply(db: Db, ctx: TenantContext, args: ApplyArgs): Promise<RiskSnapshot> {
  const isAsset = args.subjectType === "ASSET";

  const derived = isAsset
    ? await deriveForAsset(db, args.subjectId)
    : await deriveForVendor(db, args.subjectId);

  const existing = isAsset
    ? await db.risk.findUnique({ where: { assetId: args.subjectId } })
    : await db.vendorRisk.findUnique({ where: { vendorId: args.subjectId } });

  // An automatic recalculation has no assessment to work from. If none exists
  // yet there is nothing to recalculate -- deriving two factors and inventing
  // the other two would be fabricating an assessment nobody made.
  if (!args.assessment && !existing) {
    throw new NotFoundError(
      `No risk assessment exists for ${isAsset ? "asset" : "vendor"} ${args.subjectId}.`,
    );
  }

  // Pins survive a recalculation; an assessment that supplies a factor sets
  // the pin, and one that omits it releases it back to the derivation.
  const exposurePinned = args.assessment
    ? args.assessment.exposure !== undefined
    : (existing?.exposureOverridden ?? false);
  const controlGapPinned = args.assessment
    ? args.assessment.controlGap !== undefined
    : (existing?.controlGapOverridden ?? false);

  const likelihood = args.assessment?.likelihood ?? existing!.likelihood;
  const impact = args.assessment?.impact ?? existing!.impact;

  const exposure = exposurePinned
    ? (args.assessment?.exposure ?? existing!.exposure)
    : derived.exposure.value;
  const controlGap = controlGapPinned
    ? (args.assessment?.controlGap ?? existing!.controlGap)
    : derived.controlGap.value;

  const { score, band } = computeRisk(likelihood, impact, exposure, controlGap);

  const previous = existing ? { score: existing.score, band: existing.band } : null;
  const changed =
    !existing ||
    existing.score !== score ||
    existing.band !== band ||
    existing.likelihood !== likelihood ||
    existing.impact !== impact ||
    existing.exposure !== exposure ||
    existing.controlGap !== controlGap;

  const data = {
    likelihood, impact, exposure, controlGap, score, band,
    exposureOverridden: exposurePinned,
    controlGapOverridden: controlGapPinned,
    computedAt: new Date(),
  };

  const row = isAsset
    ? await db.risk.upsert({
        where: { assetId: args.subjectId },
        create: { organizationId: ctx.organizationId, assetId: args.subjectId, ...data },
        update: data,
      })
    : await db.vendorRisk.upsert({
        where: { vendorId: args.subjectId },
        create: { organizationId: ctx.organizationId, vendorId: args.subjectId, ...data },
        update: data,
      });

  const summary = derivationSummary(
    exposurePinned ? null : derived.exposure,
    controlGapPinned ? null : derived.controlGap,
  );

  // A recalculation that moved nothing is not history. Recording it would bury
  // the changes that matter under rows saying "still 8.64".
  if (changed) {
    await db.riskHistory.create({
      data: {
        organizationId: ctx.organizationId,
        subjectType: args.subjectType,
        ...(isAsset
          ? { assetId: args.subjectId, riskId: row.id }
          : { vendorId: args.subjectId, vendorRiskId: row.id }),
        previousScore: previous?.score ?? null,
        previousBand: previous?.band ?? null,
        score, band, likelihood, impact, exposure, controlGap,
        reason: args.reason,
        changedById: ctx.userId,
      },
    });
  }

  return {
    id: row.id,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    subjectName: derived.name,
    assetId: isAsset ? args.subjectId : null,
    assetName: isAsset ? derived.name : null,
    vendorId: isAsset ? null : args.subjectId,
    vendorName: isAsset ? null : derived.name,
    likelihood, impact, exposure, controlGap,
    exposureOverridden: exposurePinned,
    controlGapOverridden: controlGapPinned,
    score, band,
    computedAt: row.computedAt,
    previous,
    changed,
    derivation: summary,
  };
}

/** Runs `apply` in its own transaction when the caller is not already in one. */
async function applyStandalone(ctx: TenantContext, args: ApplyArgs): Promise<RiskSnapshot> {
  return prisma.$transaction((tx) => apply(tx, ctx, args));
}

/** Scoped existence check. Never findUnique by id alone -- see lib/tenant.ts. */
async function assertInTenant(
  db: Db,
  ctx: TenantContext,
  subjectType: RiskSubject,
  id: number,
): Promise<void> {
  const found =
    subjectType === "ASSET"
      ? await db.asset.findFirst({ where: { id, ...scope(ctx) }, select: { id: true } })
      : await db.vendor.findFirst({ where: { id, ...scope(ctx) }, select: { id: true } });

  if (!found) {
    throw new NotFoundError(`${subjectType === "ASSET" ? "Asset" : "Vendor"} ${id} not found`);
  }
}

// ---------------------------------------------------------- explicit paths

/** Records an assessor's judgement for an asset. */
export async function assessAsset(
  ctx: TenantContext,
  assetId: number,
  inputs: AssessmentInputs,
): Promise<RiskSnapshot> {
  await assertInTenant(prisma, ctx, "ASSET", assetId);
  const existing = await prisma.risk.findUnique({ where: { assetId } });
  return applyStandalone(ctx, {
    subjectType: "ASSET",
    subjectId: assetId,
    reason: existing ? "MANUAL_ASSESSMENT" : "INITIAL_ASSESSMENT",
    assessment: inputs,
  });
}

/** Records an assessor's judgement for a vendor. */
export async function assessVendor(
  ctx: TenantContext,
  vendorId: number,
  inputs: AssessmentInputs,
): Promise<RiskSnapshot> {
  await assertInTenant(prisma, ctx, "VENDOR", vendorId);
  const existing = await prisma.vendorRisk.findUnique({ where: { vendorId } });
  return applyStandalone(ctx, {
    subjectType: "VENDOR",
    subjectId: vendorId,
    reason: existing ? "MANUAL_ASSESSMENT" : "INITIAL_ASSESSMENT",
    assessment: inputs,
  });
}

/**
 * Re-scores from stored judgement plus freshly derived factors.
 *
 * Still 404s when nothing has been assessed: recompute derives two factors and
 * has no basis for the other two.
 */
export async function recomputeAssetRisk(
  ctx: TenantContext,
  assetId: number,
): Promise<RiskSnapshot> {
  await assertInTenant(prisma, ctx, "ASSET", assetId);
  const risk = await prisma.risk.findUnique({ where: { assetId } });
  if (!risk) {
    throw new NotFoundError(
      `No risk assessment exists for asset ${assetId}. Create one with POST /api/assets/${assetId}/assessment.`,
    );
  }
  return applyStandalone(ctx, { subjectType: "ASSET", subjectId: assetId, reason: "RECOMPUTE" });
}

export async function recomputeVendorRisk(
  ctx: TenantContext,
  vendorId: number,
): Promise<RiskSnapshot> {
  await assertInTenant(prisma, ctx, "VENDOR", vendorId);
  const risk = await prisma.vendorRisk.findUnique({ where: { vendorId } });
  if (!risk) {
    throw new NotFoundError(
      `No risk assessment exists for vendor ${vendorId}. Create one with POST /api/vendors/${vendorId}/assessment.`,
    );
  }
  return applyStandalone(ctx, { subjectType: "VENDOR", subjectId: vendorId, reason: "RECOMPUTE" });
}

/** Used by the import path, which supplies its own reason. */
export async function applyImportedAssessment(
  ctx: TenantContext,
  assetId: number,
  inputs: Required<Pick<AssessmentInputs, "likelihood" | "impact">> & AssessmentInputs,
): Promise<RiskSnapshot> {
  return applyStandalone(ctx, {
    subjectType: "ASSET", subjectId: assetId, reason: "IMPORTED", assessment: inputs,
  });
}

// ------------------------------------------------------- automatic paths

/**
 * Recalculate after something changed. The entry point every mutating service
 * calls.
 *
 * Silently does nothing when the subject has never been assessed: there is no
 * judgement to recompute against, and inventing one would be worse than
 * leaving the asset unassessed and visible as such. Callers therefore do not
 * need to know whether an assessment exists.
 *
 * Returns the snapshot when something moved, `null` otherwise -- which is what
 * lets callers audit only real changes.
 */
export async function recalculate(
  ctx: TenantContext,
  subjectType: RiskSubject,
  subjectId: number,
  reason: RiskChangeReason,
  db?: Db,
): Promise<RiskSnapshot | null> {
  const client = db ?? prisma;

  const existing =
    subjectType === "ASSET"
      ? await client.risk.findUnique({ where: { assetId: subjectId }, select: { id: true } })
      : await client.vendorRisk.findUnique({ where: { vendorId: subjectId }, select: { id: true } });

  if (!existing) return null;

  const snapshot = db
    ? await apply(db, ctx, { subjectType, subjectId, reason })
    : await applyStandalone(ctx, { subjectType, subjectId, reason });

  return snapshot.changed ? snapshot : null;
}

export const recalculateAsset = (
  ctx: TenantContext, assetId: number, reason: RiskChangeReason, db?: Db,
) => recalculate(ctx, "ASSET", assetId, reason, db);

export const recalculateVendor = (
  ctx: TenantContext, vendorId: number, reason: RiskChangeReason, db?: Db,
) => recalculate(ctx, "VENDOR", vendorId, reason, db);

/**
 * Recalculates every asset a vendor can reach, plus the vendor itself.
 *
 * Used when a vendor's reach changes: both sides of that relationship moved.
 */
export async function recalculateVendorAndItsAssets(
  ctx: TenantContext,
  vendorId: number,
  reason: RiskChangeReason,
  db?: Db,
): Promise<RiskSnapshot[]> {
  const client = db ?? prisma;
  const links = await client.vendorAssetAccess.findMany({
    where: { vendorId },
    select: { assetId: true },
  });

  const results: Array<RiskSnapshot | null> = [
    await recalculateVendor(ctx, vendorId, reason, db),
  ];
  for (const link of links) {
    results.push(await recalculateAsset(ctx, link.assetId, reason, db));
  }
  return results.filter((r): r is RiskSnapshot => r !== null);
}

/** Recalculates a list of assets, returning only those that actually moved. */
export async function recalculateAssets(
  ctx: TenantContext,
  assetIds: number[],
  reason: RiskChangeReason,
  db?: Db,
): Promise<RiskSnapshot[]> {
  const out: RiskSnapshot[] = [];
  for (const id of [...new Set(assetIds)]) {
    const snapshot = await recalculateAsset(ctx, id, reason, db);
    if (snapshot) out.push(snapshot);
  }
  return out;
}

// --------------------------------------------------------------- history

export type RiskHistoryEntry = {
  id: number;
  subjectType: RiskSubject;
  subjectId: number;
  subjectName: string;
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
 * Movement over time, newest first, for assets and vendors alike. `delta` is
 * precomputed server-side so the chart and the "65 -> 72" label agree without
 * the client re-deriving it.
 */
export async function listRiskHistory(
  ctx: TenantContext,
  options: {
    assetId?: number;
    vendorId?: number;
    subjectType?: RiskSubject;
    skip?: number;
    take?: number;
  } = {},
): Promise<{ entries: RiskHistoryEntry[]; total: number }> {
  const where: Prisma.RiskHistoryWhereInput = {
    ...scope(ctx),
    ...(options.assetId !== undefined ? { assetId: options.assetId } : {}),
    ...(options.vendorId !== undefined ? { vendorId: options.vendorId } : {}),
    ...(options.subjectType ? { subjectType: options.subjectType } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.riskHistory.findMany({
      where,
      orderBy: { changedAt: "desc" },
      skip: options.skip,
      take: options.take,
      include: {
        asset: { select: { name: true } },
        vendor: { select: { name: true } },
        changedBy: { select: { id: true, email: true } },
      },
    }),
    prisma.riskHistory.count({ where }),
  ]);

  return {
    total,
    entries: rows.map((r) => ({
      id: r.id,
      subjectType: r.subjectType,
      subjectId: (r.assetId ?? r.vendorId) as number,
      subjectName: r.asset?.name ?? r.vendor?.name ?? "(removed)",
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
