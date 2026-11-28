import { prisma } from "../lib/prisma.js";
import type { TenantContext } from "../lib/tenant.js";

const DEFAULTS = { accessStaleAfterDays: 90, assessmentCadenceDays: 365, mfaRequired: false };

/** Upserts-on-read: an org with no row yet just gets the defaults, materialized on first write. */
export async function getOrgSettings(organizationId: number) {
  const settings = await prisma.organizationSettings.findUnique({ where: { organizationId } });
  return settings ?? { organizationId, ...DEFAULTS, updatedAt: null };
}

export type OrgSettingsInput = Partial<typeof DEFAULTS>;

export async function updateOrgSettings(ctx: TenantContext, input: OrgSettingsInput) {
  return prisma.organizationSettings.upsert({
    where: { organizationId: ctx.organizationId },
    update: input,
    create: { organizationId: ctx.organizationId, ...DEFAULTS, ...input },
  });
}
