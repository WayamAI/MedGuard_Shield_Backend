import type { AccessLevel, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";

/**
 * Access review.
 *
 * The flag rules are unchanged — they were the correct rules — but access is
 * no longer read-only: grants can now be created, re-levelled, revoked and
 * marked reviewed, and each of those is audited by the route layer.
 *
 * Revocation sets `revokedAt` rather than deleting the row. Who lost which
 * access and when is precisely what an access review has to answer six months
 * later, and a DELETE destroys it.
 */

export const STALE_AFTER_DAYS = 90;

/**
 * Each flag describes something wrong with the grant itself.
 *
 * "Never reviewed" is deliberately NOT one of them. Review status is a
 * property of our process, not of the access, and a flag that fires on every
 * row of a fresh estate would drown the four that mean something -- this list
 * is what `riskFlagCount` sorts by. `lastReviewedAt` is returned on every row
 * and counted separately in the summary, so the UI can still surface it.
 */
export type GrantFlag =
  | "STALE"
  | "NEVER_USED"
  | "NO_MFA"
  | "INACTIVE_IDENTITY"
  | "EXCESSIVE_LEVEL";

/** An asset above this PHI volume makes non-READ access worth flagging. */
const HIGH_VOLUME_THRESHOLD = 50_000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

type FlagInput = {
  lastUsedAt: Date | null;
  level: AccessLevel;
  identity: { active: boolean; kind: string; mfaEnabled: boolean };
  asset: { phiVolume: number };
};

export function flagsFor(grant: FlagInput): GrantFlag[] {
  const flags: GrantFlag[] = [];
  const now = new Date();
  const idle = grant.lastUsedAt ? daysBetween(grant.lastUsedAt, now) : null;

  if (grant.lastUsedAt === null) flags.push("NEVER_USED");
  else if (idle !== null && idle > STALE_AFTER_DAYS) flags.push("STALE");

  if (!grant.identity.active) flags.push("INACTIVE_IDENTITY");

  // Service accounts have no MFA by definition, so flagging them for it would
  // be noise on every row rather than a finding.
  if (grant.identity.kind === "USER" && !grant.identity.mfaEnabled) flags.push("NO_MFA");

  if (grant.level !== "READ" && grant.asset.phiVolume > HIGH_VOLUME_THRESHOLD) {
    flags.push("EXCESSIVE_LEVEL");
  }

  return flags;
}

export type AccessFilters = {
  assetId?: number;
  identityId?: number;
  level?: AccessLevel;
  flaggedOnly?: boolean;
  includeRevoked?: boolean;
  search?: string;
};

function listWhere(ctx: TenantContext, filters: AccessFilters): Prisma.AccessGrantWhereInput {
  return {
    ...scope(ctx),
    ...(filters.includeRevoked ? {} : { revokedAt: null }),
    ...(filters.assetId ? { assetId: filters.assetId } : {}),
    ...(filters.identityId ? { identityId: filters.identityId } : {}),
    ...(filters.level ? { level: filters.level } : {}),
    ...(filters.search
      ? {
          OR: [
            { identity: { displayName: { contains: filters.search, mode: "insensitive" as const } } },
            { asset: { name: { contains: filters.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
}

/**
 * Every access grant, flattened for the review table, ordered worst-first.
 *
 * Flags are derived per row and `flaggedOnly` therefore filters after the
 * fetch. When that filter is on, the query runs unpaginated and the page is
 * taken from the filtered set, so page counts stay truthful.
 */
export async function listAccessGrants(
  ctx: TenantContext,
  filters: AccessFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where = listWhere(ctx, filters);
  const include = {
    identity: {
      select: {
        id: true, displayName: true, email: true, kind: true,
        department: true, active: true, mfaEnabled: true,
      },
    },
    asset: { select: { id: true, name: true, type: true, phiVolume: true } },
  } as const;

  const rows = await prisma.accessGrant.findMany({
    where,
    include,
    ...(filters.flaggedOnly ? {} : { skip: page.skip, take: page.take }),
    orderBy: { grantedAt: "desc" },
  });

  const shaped = rows.map((g) => {
    const flags = flagsFor(g);
    const now = new Date();
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
      lastReviewedAt: g.lastReviewedAt,
      revokedAt: g.revokedAt,
      daysSinceUse: g.lastUsedAt ? daysBetween(g.lastUsedAt, now) : null,
      daysSinceGrant: daysBetween(g.grantedAt, now),
      flags,
      riskFlagCount: flags.length,
    };
  });

  shaped.sort((a, b) => {
    if (b.riskFlagCount !== a.riskFlagCount) return b.riskFlagCount - a.riskFlagCount;
    return (b.daysSinceUse ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceUse ?? Number.MAX_SAFE_INTEGER);
  });

  if (filters.flaggedOnly) {
    const flagged = shaped.filter((r) => r.riskFlagCount > 0);
    const start = page.skip ?? 0;
    const end = page.take === undefined ? undefined : start + page.take;
    return { items: flagged.slice(start, end), total: flagged.length, summary: summarise(shaped) };
  }

  const total = await prisma.accessGrant.count({ where });
  return { items: shaped, total, summary: summarise(shaped) };
}

type Shaped = { flags: GrantFlag[]; lastReviewedAt: Date | null };

/**
 * Summary over the rows on this page. Documented as such because it is easy to
 * misread as an estate-wide total once pagination is on — `/api/access/summary`
 * is the endpoint that counts the whole register.
 */
function summarise(rows: Shaped[]) {
  return {
    total: rows.length,
    flagged: rows.filter((r) => r.flags.length > 0).length,
    stale: rows.filter((r) => r.flags.includes("STALE")).length,
    neverUsed: rows.filter((r) => r.flags.includes("NEVER_USED")).length,
    withoutMfa: rows.filter((r) => r.flags.includes("NO_MFA")).length,
    inactiveIdentities: rows.filter((r) => r.flags.includes("INACTIVE_IDENTITY")).length,
    excessiveLevel: rows.filter((r) => r.flags.includes("EXCESSIVE_LEVEL")).length,
    neverReviewed: rows.filter((r) => r.lastReviewedAt === null).length,
    staleAfterDays: STALE_AFTER_DAYS,
  };
}

/** Estate-wide counts, computed over every live grant rather than one page. */
export async function accessSummary(ctx: TenantContext) {
  const rows = await prisma.accessGrant.findMany({
    where: { ...scope(ctx), revokedAt: null },
    include: {
      identity: { select: { active: true, kind: true, mfaEnabled: true } },
      asset: { select: { phiVolume: true } },
    },
  });

  return summarise(rows.map((g) => ({ flags: flagsFor(g), lastReviewedAt: g.lastReviewedAt })));
}

export async function getAccessGrantById(ctx: TenantContext, id: number) {
  const grant = await prisma.accessGrant.findFirst({
    where: { id, ...scope(ctx) },
    include: {
      identity: true,
      asset: { select: { id: true, name: true, type: true, phiVolume: true } },
    },
  });
  if (!grant) throw new NotFoundError(`Access grant ${id} not found`);

  const flags = flagsFor(grant);
  return {
    id: grant.id,
    identityId: grant.identityId,
    identityName: grant.identity.displayName,
    assetId: grant.assetId,
    assetName: grant.asset.name,
    level: grant.level,
    grantedAt: grant.grantedAt,
    lastUsedAt: grant.lastUsedAt,
    lastReviewedAt: grant.lastReviewedAt,
    revokedAt: grant.revokedAt,
    flags,
    riskFlagCount: flags.length,
  };
}

export type GrantInput = {
  identityId: number;
  assetId: number;
  level?: AccessLevel;
  grantedAt?: Date;
  lastUsedAt?: Date | null;
};

/**
 * Grants access. Re-granting a previously revoked pair reactivates that row
 * rather than creating a second one, because the unique constraint is on
 * (identityId, assetId) and the grant's history is worth keeping attached.
 */
export async function grantAccess(ctx: TenantContext, input: GrantInput) {
  const [identity, asset] = await Promise.all([
    prisma.identity.findFirst({ where: { id: input.identityId, ...scope(ctx) }, select: { id: true } }),
    prisma.asset.findFirst({ where: { id: input.assetId, ...scope(ctx) }, select: { id: true } }),
  ]);
  if (!identity) throw new NotFoundError(`Identity ${input.identityId} not found`);
  if (!asset) throw new NotFoundError(`Asset ${input.assetId} not found`);

  const existing = await prisma.accessGrant.findUnique({
    where: { identityId_assetId: { identityId: input.identityId, assetId: input.assetId } },
  });

  if (existing && existing.revokedAt === null) {
    throw new ConflictError(
      `Identity ${input.identityId} already has access to asset ${input.assetId}`,
    );
  }

  const data = {
    organizationId: ctx.organizationId,
    identityId: input.identityId,
    assetId: input.assetId,
    level: input.level ?? "READ",
    grantedAt: input.grantedAt ?? new Date(),
    lastUsedAt: input.lastUsedAt ?? null,
  };

  if (existing) {
    return prisma.accessGrant.update({
      where: { id: existing.id },
      data: { ...data, revokedAt: null, revokedById: null },
    });
  }

  return prisma.accessGrant.create({ data });
}

export async function updateAccessGrant(
  ctx: TenantContext,
  id: number,
  input: { level?: AccessLevel; lastUsedAt?: Date | null },
) {
  const grant = await prisma.accessGrant.findFirst({ where: { id, ...scope(ctx) } });
  if (!grant) throw new NotFoundError(`Access grant ${id} not found`);
  if (grant.revokedAt) throw new ConflictError(`Access grant ${id} is revoked`);

  const after = await prisma.accessGrant.update({ where: { id }, data: input });
  return { before: grant, after };
}

/** Revokes access, recording who did it. The row stays. */
export async function revokeAccessGrant(ctx: TenantContext, id: number) {
  const grant = await prisma.accessGrant.findFirst({ where: { id, ...scope(ctx) } });
  if (!grant) throw new NotFoundError(`Access grant ${id} not found`);
  if (grant.revokedAt) throw new ConflictError(`Access grant ${id} is already revoked`);

  return prisma.accessGrant.update({
    where: { id },
    data: { revokedAt: new Date(), revokedById: ctx.userId },
  });
}

/**
 * Marks a grant as reviewed. This is what clears the NEVER_REVIEWED flag and
 * is the recorded act an access-review attestation rests on.
 */
export async function reviewAccessGrant(ctx: TenantContext, id: number) {
  const grant = await prisma.accessGrant.findFirst({ where: { id, ...scope(ctx) } });
  if (!grant) throw new NotFoundError(`Access grant ${id} not found`);

  return prisma.accessGrant.update({ where: { id }, data: { lastReviewedAt: new Date() } });
}
