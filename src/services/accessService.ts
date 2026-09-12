import { prisma } from "../lib/prisma.js";

/**
 * A grant is stale once it has gone this long unused. 90 days is the common
 * access-review cadence, so anything past it has survived a review it should
 * have been caught by.
 */
export const STALE_AFTER_DAYS = 90;

export type GrantFlag = "STALE" | "NEVER_USED" | "NO_MFA" | "INACTIVE_IDENTITY" | "EXCESSIVE_LEVEL";

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

/**
 * Why a grant is worth a reviewer's attention. Returned as a list rather than
 * a single verdict because the remedies differ: a stale grant gets revoked, a
 * grant held without MFA gets an MFA requirement, and they can coexist.
 */
function flagsFor(grant: {
  lastUsedAt: Date | null;
  level: string;
  identity: { active: boolean; mfaEnabled: boolean; kind: string };
  asset: { phiVolume: number };
}): GrantFlag[] {
  const flags: GrantFlag[] = [];
  const idle = daysSince(grant.lastUsedAt);

  if (grant.lastUsedAt === null) flags.push("NEVER_USED");
  else if (idle !== null && idle > STALE_AFTER_DAYS) flags.push("STALE");

  if (!grant.identity.active) flags.push("INACTIVE_IDENTITY");

  // Service accounts do not do MFA, so only flag humans for it.
  if (grant.identity.kind === "USER" && !grant.identity.mfaEnabled) flags.push("NO_MFA");

  // Write or admin rights over a high-volume PHI store is the combination
  // worth arguing about in a review.
  if (grant.level !== "READ" && grant.asset.phiVolume > 50_000) flags.push("EXCESSIVE_LEVEL");

  return flags;
}

/**
 * Every access grant, flattened for the access review table: who, to what, at
 * what level, how long since they used it, and what is wrong with it.
 * Ordered worst-first so a reviewer starts where it matters.
 */
export async function listAccessGrants() {
  const grants = await prisma.accessGrant.findMany({
    include: {
      identity: true,
      asset: { select: { id: true, name: true, type: true, phiVolume: true } },
    },
  });

  const rows = grants.map((g) => {
    const flags = flagsFor(g);
    return {
      id: g.id,
      identityId: g.identity.id,
      identityName: g.identity.displayName,
      identityEmail: g.identity.email,
      kind: g.identity.kind,
      department: g.identity.department,
      active: g.identity.active,
      mfaEnabled: g.identity.mfaEnabled,
      assetId: g.asset.id,
      assetName: g.asset.name,
      assetType: g.asset.type,
      level: g.level,
      grantedAt: g.grantedAt,
      lastUsedAt: g.lastUsedAt,
      daysSinceUse: daysSince(g.lastUsedAt),
      daysSinceGrant: daysSince(g.grantedAt),
      flags,
      // One number so a table can sort without re-deriving the rules.
      riskFlagCount: flags.length,
    };
  });

  rows.sort((a, b) => {
    if (b.riskFlagCount !== a.riskFlagCount) return b.riskFlagCount - a.riskFlagCount;
    return (b.daysSinceUse ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceUse ?? Number.MAX_SAFE_INTEGER);
  });

  const summary = {
    total: rows.length,
    flagged: rows.filter((r) => r.flags.length > 0).length,
    stale: rows.filter((r) => r.flags.includes("STALE")).length,
    neverUsed: rows.filter((r) => r.flags.includes("NEVER_USED")).length,
    withoutMfa: rows.filter((r) => r.flags.includes("NO_MFA")).length,
    inactiveIdentities: rows.filter((r) => r.flags.includes("INACTIVE_IDENTITY")).length,
    excessiveLevel: rows.filter((r) => r.flags.includes("EXCESSIVE_LEVEL")).length,
    staleAfterDays: STALE_AFTER_DAYS,
  };

  return { summary, grants: rows };
}
