import type { BaaStatus } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { computeRisk } from "./riskScoring.js";

const latestRisk = { orderBy: { computedAt: "desc" }, take: 1 } as const;

/** Days since an assessment, or null if never assessed. */
function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

/**
 * A vendor is overdue if it has not been assessed in a year, or never has.
 * Never-assessed counts as overdue rather than "unknown" -- an unassessed
 * vendor with PHI access is the worse case, not the neutral one.
 */
const ASSESSMENT_INTERVAL_DAYS = 365;

function assessmentOverdue(lastAssessedAt: Date | null): boolean {
  const days = daysSince(lastAssessedAt);
  return days === null || days > ASSESSMENT_INTERVAL_DAYS;
}

export async function listVendors() {
  const vendors = await prisma.vendor.findMany({
    orderBy: { name: "asc" },
    include: {
      risks: latestRisk,
      assetAccess: { include: { asset: { select: { name: true } } } },
    },
  });

  return vendors.map((v) => {
    const risk = v.risks[0];
    return {
      id: v.id,
      name: v.name,
      baaStatus: v.baaStatus,
      phiVolume: v.phiVolume,
      lastAssessedAt: v.lastAssessedAt,
      daysSinceAssessment: daysSince(v.lastAssessedAt),
      assessmentOverdue: assessmentOverdue(v.lastAssessedAt),
      // A vendor touching PHI without a signed BAA is a HIPAA breach on its
      // own, so it is surfaced as a first-class flag rather than leaving the
      // client to re-derive it from baaStatus.
      baaCompliant: v.baaStatus === "SIGNED",
      assetCount: v.assetAccess.length,
      assets: v.assetAccess.map((a) => a.asset.name),
      risk: risk ? { score: risk.score, band: risk.band, computedAt: risk.computedAt } : null,
    };
  });
}

export async function getVendorById(id: number) {
  const v = await prisma.vendor.findUnique({
    where: { id },
    include: {
      risks: latestRisk,
      assetAccess: {
        include: { asset: { select: { id: true, name: true, type: true, encrypted: true } } },
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
    assets: v.assetAccess.map((a) => ({
      id: a.asset.id,
      name: a.asset.name,
      type: a.asset.type,
      encrypted: a.asset.encrypted,
      grantedAt: a.grantedAt,
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
  };
}

export type VendorWriteInput = {
  name: string;
  baaStatus?: BaaStatus;
  phiVolume?: number;
  lastAssessedAt?: Date | null;
};

export async function createVendor(input: VendorWriteInput) {
  const existing = await prisma.vendor.findUnique({ where: { name: input.name } });
  if (existing) throw new ConflictError(`A vendor named "${input.name}" already exists`);
  return prisma.vendor.create({ data: input });
}

export async function updateVendor(id: number, input: Partial<VendorWriteInput>) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) throw new NotFoundError(`Vendor ${id} not found`);

  if (input.name && input.name !== vendor.name) {
    const clash = await prisma.vendor.findUnique({ where: { name: input.name } });
    if (clash) throw new ConflictError(`A vendor named "${input.name}" already exists`);
  }
  return prisma.vendor.update({ where: { id }, data: input });
}

/** Re-scores a vendor from its stored inputs, using the shared risk engine. */
export async function recomputeVendorRisk(vendorId: number) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, name: true },
  });
  if (!vendor) throw new NotFoundError(`Vendor ${vendorId} not found`);

  const risk = await prisma.vendorRisk.findFirst({
    where: { vendorId },
    orderBy: { computedAt: "desc" },
  });
  if (!risk) throw new NotFoundError(`No risk record exists for vendor ${vendorId}`);

  const { score, band } = computeRisk(
    risk.likelihood, risk.impact, risk.exposure, risk.controlGap,
  );
  const updated = await prisma.vendorRisk.update({
    where: { id: risk.id },
    data: { score, band, computedAt: new Date() },
  });

  return {
    id: updated.id,
    vendorId: updated.vendorId,
    vendorName: vendor.name,
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
