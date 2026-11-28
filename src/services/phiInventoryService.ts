import { prisma } from "../lib/prisma.js";
import type { Sensitivity } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { isUniqueViolation } from "./assetService.js";
import { scope, type TenantContext } from "../lib/tenant.js";

/**
 * PHI inventory — metadata only, matching the product's no-patient-records
 * invariant: this reports *categories* of PHI, which systems hold them, and
 * aggregate volumes, never a single patient's data.
 */
export async function phiInventory(ctx: TenantContext) {
  const types = await prisma.pHIType.findMany({
    where: scope(ctx),
    orderBy: { name: "asc" },
    include: {
      links: { include: { asset: { select: { id: true, name: true, type: true, phiVolume: true } } } },
      flows: { select: { recordsPerDay: true, encrypted: true } },
    },
  });

  return types.map((t) => {
    const systems = t.links
      .filter((l) => l.asset !== null)
      .map((l) => ({ assetId: l.asset.id, assetName: l.asset.name, assetType: l.asset.type }));
    const recordsHeld = t.links.reduce((sum, l) => sum + l.asset.phiVolume, 0);
    const recordsPerDayInTransit = t.flows.reduce((sum, f) => sum + f.recordsPerDay, 0);
    const unencryptedFlows = t.flows.filter((f) => !f.encrypted).length;

    return {
      id: t.id,
      name: t.name,
      sensitivity: t.sensitivity,
      systems,
      recordsHeld,
      flowCount: t.flows.length,
      recordsPerDayInTransit,
      unencryptedFlows,
    };
  });
}

export async function listPhiTypes(ctx: TenantContext) {
  return prisma.pHIType.findMany({ where: scope(ctx), orderBy: { name: "asc" } });
}

export async function getPhiTypeById(ctx: TenantContext, id: number) {
  const type = await prisma.pHIType.findFirst({ where: { ...scope(ctx), id } });
  if (!type) throw new NotFoundError("PHI type not found");
  return type;
}

export async function createPhiType(ctx: TenantContext, input: { name: string; sensitivity: Sensitivity }) {
  try {
    return await prisma.pHIType.create({ data: { ...input, organizationId: ctx.organizationId } });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A PHI type named "${input.name}" already exists`);
    throw err;
  }
}

export async function updatePhiType(
  ctx: TenantContext,
  id: number,
  input: Partial<{ name: string; sensitivity: Sensitivity }>,
) {
  await getPhiTypeById(ctx, id);
  try {
    return await prisma.pHIType.update({ where: { id }, data: input });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A PHI type named "${input.name}" already exists`);
    throw err;
  }
}
