import type { Request } from "express";
import type { RiskChangeReason } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { TenantContext } from "../lib/tenant.js";
import { recordAudit } from "./auditService.js";
import {
  recalculateAsset, recalculateAssets, recalculateVendor,
  recalculateVendorAndItsAssets, type RiskSnapshot,
} from "./riskEngine.js";

/**
 * The bridge between "something changed" and "recompute the risk".
 *
 * Routes call one of these after persisting a mutation. They contain no
 * scoring logic whatsoever -- every calculation happens in riskEngine.ts, and
 * these functions only decide *which subjects* a given mutation could have
 * moved, then record the audit trail for the ones that actually did.
 *
 * ## Why recalculation is not automatic-everywhere
 *
 * Only mutations that change a *derived* factor are wired up. Renaming an
 * asset cannot move a score, so renaming an asset does not trigger a
 * recalculation; firing one anyway would write no history row (the engine
 * suppresses no-op changes) but would still cost a query per edit for nothing.
 *
 * ## Why this cannot loop
 *
 * Recalculation reads the graph and writes Risk, RiskHistory and AuditEvent.
 * It never writes an asset, vendor, grant, control or threat, so it cannot
 * trigger itself. That invariant lives in riskEngine.ts and is what makes
 * these safe to call from inside any mutation, including inside a transaction.
 */

/** Asset fields that feed the derived exposure factor. */
const ASSET_RISK_FIELDS = ["phiVolume", "encrypted", "mfaEnabled"] as const;
/** Vendor fields that feed the derived vendor factors. */
const VENDOR_RISK_FIELDS = ["baaStatus", "lastAssessedAt"] as const;
/** Control fields that feed the derived control-gap factor. */
const CONTROL_RISK_FIELDS = ["status", "effectiveness"] as const;

export function assetFieldsAffectRisk(input: Record<string, unknown>): boolean {
  return ASSET_RISK_FIELDS.some((f) => input[f] !== undefined);
}

export function vendorFieldsAffectRisk(input: Record<string, unknown>): boolean {
  return VENDOR_RISK_FIELDS.some((f) => input[f] !== undefined);
}

export function controlFieldsAffectRisk(input: Record<string, unknown>): boolean {
  return CONTROL_RISK_FIELDS.some((f) => input[f] !== undefined);
}

/**
 * Writes one RISK_RECOMPUTED audit row per subject that actually moved.
 *
 * `derivation` carries the reasons the derived factors landed where they did,
 * so the trail says *why* -- "87,100 PHI records; PHI stored unencrypted; 2
 * grant(s) above READ" -- rather than only that a number changed.
 */
async function auditChanges(
  ctx: TenantContext,
  req: Request | undefined,
  snapshots: RiskSnapshot[],
): Promise<void> {
  for (const s of snapshots) {
    await recordAudit(ctx, {
      action: "RISK_RECOMPUTED",
      entityType: s.subjectType === "ASSET" ? "Asset" : "Vendor",
      entityId: s.subjectId,
      metadata: {
        trigger: "automatic",
        previousScore: s.previous?.score ?? null,
        previousBand: s.previous?.band ?? null,
        score: s.score,
        band: s.band,
        exposure: s.exposure,
        controlGap: s.controlGap,
        derivation: s.derivation,
      },
      ...(req ? { req } : {}),
    });
  }
}

export type TriggerResult = {
  /** Subjects whose score actually moved. Empty when nothing changed. */
  changed: RiskSnapshot[];
};

/** One asset changed in a way that could move its exposure or control gap. */
export async function onAssetChanged(
  ctx: TenantContext,
  assetId: number,
  reason: RiskChangeReason,
  req?: Request,
): Promise<TriggerResult> {
  const snapshot = await recalculateAsset(ctx, assetId, reason);
  const changed = snapshot ? [snapshot] : [];
  await auditChanges(ctx, req, changed);
  return { changed };
}

/** Several assets changed at once -- an identity archived, an import landed. */
export async function onAssetsChanged(
  ctx: TenantContext,
  assetIds: number[],
  reason: RiskChangeReason,
  req?: Request,
): Promise<TriggerResult> {
  const changed = await recalculateAssets(ctx, assetIds, reason);
  await auditChanges(ctx, req, changed);
  return { changed };
}

/** A vendor's own posture changed -- BAA state, assessment recency. */
export async function onVendorChanged(
  ctx: TenantContext,
  vendorId: number,
  reason: RiskChangeReason,
  req?: Request,
): Promise<TriggerResult> {
  const snapshot = await recalculateVendor(ctx, vendorId, reason);
  const changed = snapshot ? [snapshot] : [];
  await auditChanges(ctx, req, changed);
  return { changed };
}

/**
 * A vendor's reach changed. Both sides move: the vendor's exposure follows the
 * assets it can touch, and each asset's exposure follows how many vendors can
 * touch it.
 *
 * `alsoAsset` covers the unlink case, where the asset is no longer joined to
 * the vendor and so would not be found by walking the vendor's links.
 */
export async function onVendorAccessChanged(
  ctx: TenantContext,
  vendorId: number,
  alsoAsset: number | null,
  req?: Request,
): Promise<TriggerResult> {
  const changed = await recalculateVendorAndItsAssets(ctx, vendorId, "VENDOR_ACCESS_CHANGED");

  if (alsoAsset !== null && !changed.some((s) => s.subjectType === "ASSET" && s.subjectId === alsoAsset)) {
    const snapshot = await recalculateAsset(ctx, alsoAsset, "VENDOR_ACCESS_CHANGED");
    if (snapshot) changed.push(snapshot);
  }

  await auditChanges(ctx, req, changed);
  return { changed };
}

/**
 * A control's status or effectiveness changed, which moves the control-gap
 * factor of every asset it is applied to.
 */
/**
 * PHI flows were added or changed.
 *
 * Only the *source* asset of a flow can move: exposure counts
 * `unencryptedOutboundFlows`, which riskEngine reads as this asset's outbound
 * flows where `encrypted: false`. The target asset receives records but its
 * own outbound count is untouched, so it is not passed here.
 *
 * Callers may pass the source of every imported flow rather than filtering to
 * the unencrypted ones. That is deliberate: `recalculate` suppresses no-op
 * changes, so an encrypted flow's source simply does not move and writes no
 * history, and the caller does not have to reproduce the engine's rule about
 * which flows count. Being over-inclusive here is cheap and cannot be wrong;
 * being under-inclusive would silently leave a stale score.
 *
 * `PHI_CHANGED` is the reason, which until now was the one RiskChangeReason
 * the code declared and never used.
 */
export async function onDataFlowsChanged(
  ctx: TenantContext,
  sourceAssetIds: number[],
  req?: Request,
): Promise<TriggerResult> {
  return onAssetsChanged(ctx, sourceAssetIds, "PHI_CHANGED", req);
}

export async function onControlChanged(
  ctx: TenantContext,
  controlId: number,
  req?: Request,
): Promise<TriggerResult> {
  const links = await prisma.assetControl.findMany({
    where: { controlId },
    select: { assetId: true },
  });
  return onAssetsChanged(ctx, links.map((l) => l.assetId), "CONTROL_CHANGED", req);
}
