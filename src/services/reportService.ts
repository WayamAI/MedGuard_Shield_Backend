import { prisma } from "../lib/prisma.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { accessSummary } from "./accessService.js";
import { remediationSummary } from "./remediationService.js";
import { threatSummary } from "./threatService.js";
import { riskDistribution } from "./riskService.js";

/**
 * Risk Assessment Summary.
 *
 * Every number here is counted from persisted rows at request time. There are
 * no constants, no weightings invented to make a figure look good, and no
 * "compliance score" — a single percentage claiming HIPAA posture would be a
 * fabricated metric, and this product does not get to assert one.
 *
 * What it does report is coverage: how much of the estate has been assessed,
 * how much is protected by a control anyone has marked effective, and what is
 * outstanding. Those are facts about the data.
 */
export async function riskAssessmentSummary(ctx: TenantContext) {
  const where = scope(ctx);

  const [
    organization, assetCount, archivedAssets, assessedAssets, phiAggregate,
    phiTypes, vendorCount, baaGroups, identityCount, activeGrants,
    controlCount, effectiveControls, policyCount, flowCount, unencryptedFlows,
    distribution, threats, remediations, access, topRisks, staleVendors,
  ] = await Promise.all([
    prisma.organization.findUnique({ where: { id: ctx.organizationId }, select: { id: true, name: true, slug: true } }),
    prisma.asset.count({ where: { ...where, archivedAt: null } }),
    prisma.asset.count({ where: { ...where, archivedAt: { not: null } } }),
    prisma.risk.count({ where }),
    prisma.asset.aggregate({ where: { ...where, archivedAt: null }, _sum: { phiVolume: true } }),
    prisma.pHIType.findMany({ where, select: { name: true, sensitivity: true, _count: { select: { links: true } } } }),
    prisma.vendor.count({ where: { ...where, archivedAt: null } }),
    prisma.vendor.groupBy({ by: ["baaStatus"], where: { ...where, archivedAt: null }, _count: { _all: true } }),
    prisma.identity.count({ where: { ...where, archivedAt: null } }),
    prisma.accessGrant.count({ where: { ...where, revokedAt: null } }),
    prisma.control.count({ where: { ...where, archivedAt: null } }),
    prisma.control.count({ where: { ...where, archivedAt: null, status: "IMPLEMENTED", effectiveness: "EFFECTIVE" } }),
    prisma.policy.count({ where: { ...where, archivedAt: null } }),
    prisma.dataFlow.count({ where }),
    prisma.dataFlow.count({ where: { ...where, encrypted: false } }),
    riskDistribution(ctx),
    threatSummary(ctx),
    remediationSummary(ctx),
    accessSummary(ctx),
    prisma.risk.findMany({
      where, orderBy: { score: "desc" }, take: 5,
      include: { asset: { select: { id: true, name: true, type: true } } },
    }),
    prisma.vendor.count({
      where: { ...where, archivedAt: null, baaStatus: { in: ["MISSING", "EXPIRED"] } },
    }),
  ]);

  const baa: Record<string, number> = { SIGNED: 0, PENDING: 0, EXPIRED: 0, MISSING: 0 };
  for (const g of baaGroups) baa[g.baaStatus] = g._count._all;

  return {
    organization,
    generatedAt: new Date(),

    assets: {
      total: assetCount,
      archived: archivedAssets,
      assessed: assessedAssets,
      unassessed: assetCount - assessedAssets,
      /** Share of live assets carrying a risk assessment. Coverage, not a score. */
      assessmentCoverage: assetCount === 0 ? 0 : Math.round((assessedAssets / assetCount) * 1000) / 10,
    },

    phi: {
      totalRecords: phiAggregate._sum.phiVolume ?? 0,
      categories: phiTypes.map((p) => ({
        name: p.name, sensitivity: p.sensitivity, assetCount: p._count.links,
      })),
    },

    flows: {
      total: flowCount,
      unencrypted: unencryptedFlows,
    },

    riskDistribution: distribution,

    topRisks: topRisks.map((r) => ({
      assetId: r.asset.id, assetName: r.asset.name, assetType: r.asset.type,
      score: r.score, band: r.band, computedAt: r.computedAt,
    })),

    vendors: {
      total: vendorCount,
      baaStatus: baa,
      withoutValidBaa: staleVendors,
    },

    access: {
      identities: identityCount,
      activeGrants,
      ...access,
    },

    controls: {
      total: controlCount,
      implementedAndEffective: effectiveControls,
      /** Share of controls both implemented and assessed effective. */
      effectiveRate: controlCount === 0 ? 0 : Math.round((effectiveControls / controlCount) * 1000) / 10,
      policies: policyCount,
    },

    threats,
    remediation: remediations,

    /**
     * Stated so no reader mistakes coverage figures for a compliance verdict.
     */
    disclaimer:
      "Counts are computed from records held in Drishti at generation time. Coverage percentages describe how much of the recorded estate has been assessed or controlled; they are not a compliance score and do not assert conformance with any framework.",
  };
}
