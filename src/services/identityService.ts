import type { IdentityKind, Prisma, Role } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { isUniqueViolation } from "./assetService.js";

/**
 * Identities: the people and service accounts that hold PHI access somewhere
 * in the estate. Distinct from User, which is an account that signs into
 * Drishti — most identities never log into this tool at all.
 */

export type IdentityFilters = {
  search?: string;
  kind?: IdentityKind;
  active?: boolean;
  includeArchived?: boolean;
};

function listWhere(ctx: TenantContext, filters: IdentityFilters): Prisma.IdentityWhereInput {
  return {
    ...scope(ctx),
    ...(filters.includeArchived ? {} : { archivedAt: null }),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.active !== undefined ? { active: filters.active } : {}),
    ...(filters.search
      ? {
          OR: [
            { displayName: { contains: filters.search, mode: "insensitive" as const } },
            { email: { contains: filters.search, mode: "insensitive" as const } },
            { department: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

export async function listIdentities(
  ctx: TenantContext,
  filters: IdentityFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where = listWhere(ctx, filters);

  const [rows, total] = await Promise.all([
    prisma.identity.findMany({
      where,
      orderBy: { displayName: "asc" },
      skip: page.skip,
      take: page.take,
      include: {
        _count: { select: { grants: { where: { revokedAt: null } } } },
      },
    }),
    prisma.identity.count({ where }),
  ]);

  return {
    total,
    items: rows.map((i) => ({
      id: i.id,
      displayName: i.displayName,
      email: i.email,
      kind: i.kind,
      department: i.department,
      role: i.role,
      active: i.active,
      mfaEnabled: i.mfaEnabled,
      createdAt: i.createdAt,
      archivedAt: i.archivedAt,
      activeGrants: i._count.grants,
    })),
  };
}

export async function getIdentityById(ctx: TenantContext, id: number) {
  const identity = await prisma.identity.findFirst({
    where: { id, ...scope(ctx) },
    include: {
      grants: {
        take: 200,
        include: { asset: { select: { id: true, name: true, type: true, phiVolume: true } } },
        orderBy: { grantedAt: "desc" },
      },
    },
  });
  if (!identity) throw new NotFoundError(`Identity ${id} not found`);

  return {
    id: identity.id,
    displayName: identity.displayName,
    email: identity.email,
    kind: identity.kind,
    department: identity.department,
    role: identity.role,
    active: identity.active,
    mfaEnabled: identity.mfaEnabled,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    archivedAt: identity.archivedAt,
    grants: identity.grants.map((g) => ({
      id: g.id,
      assetId: g.asset.id,
      assetName: g.asset.name,
      assetType: g.asset.type,
      level: g.level,
      grantedAt: g.grantedAt,
      lastUsedAt: g.lastUsedAt,
      lastReviewedAt: g.lastReviewedAt,
      revokedAt: g.revokedAt,
    })),
    /** Total PHI this identity can currently reach. */
    phiReach: identity.grants
      .filter((g) => g.revokedAt === null)
      .reduce((sum, g) => sum + g.asset.phiVolume, 0),
  };
}

export type IdentityWriteInput = {
  displayName: string;
  email?: string | null;
  kind?: IdentityKind;
  department?: string | null;
  role?: Role;
  active?: boolean;
  mfaEnabled?: boolean;
};

export async function createIdentity(ctx: TenantContext, input: IdentityWriteInput) {
  try {
    return await prisma.identity.create({
      data: { ...input, organizationId: ctx.organizationId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        `An identity named "${input.displayName}" (or with that email) already exists`,
      );
    }
    throw err;
  }
}

export async function updateIdentity(
  ctx: TenantContext,
  id: number,
  input: Partial<IdentityWriteInput>,
) {
  const identity = await prisma.identity.findFirst({ where: { id, ...scope(ctx) } });
  if (!identity) throw new NotFoundError(`Identity ${id} not found`);

  try {
    const after = await prisma.identity.update({ where: { id }, data: input });
    return { before: identity, after };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`An identity with that name or email already exists`);
    }
    throw err;
  }
}

/**
 * Archives an identity and revokes everything it could reach, in one
 * transaction.
 *
 * Deactivating a leaver without removing their access is the exact failure
 * this product exists to surface, so the two are not separable actions here.
 * The grants are revoked, not deleted — the review trail survives.
 */
export async function archiveIdentity(ctx: TenantContext, id: number) {
  const identity = await prisma.identity.findFirst({ where: { id, ...scope(ctx) } });
  if (!identity) throw new NotFoundError(`Identity ${id} not found`);
  if (identity.archivedAt) throw new ConflictError(`Identity ${id} is already archived`);

  return prisma.$transaction(async (tx) => {
    const revoked = await tx.accessGrant.updateMany({
      where: { identityId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: ctx.userId },
    });

    const archived = await tx.identity.update({
      where: { id },
      data: { archivedAt: new Date(), active: false },
    });

    return { identity: archived, revokedGrants: revoked.count };
  });
}
