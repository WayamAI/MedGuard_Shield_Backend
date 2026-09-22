import type { Prisma, PolicyStatus } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { isUniqueViolation } from "./assetService.js";

/**
 * The policy register: written policies and the controls that implement them.
 * Deliberately small — a register, not a GRC platform. `evidenceRef` is a
 * customer-supplied pointer (a URL, a document id); Drishti stores it and
 * makes no claim about what it contains.
 */

export type PolicyFilters = { search?: string; status?: PolicyStatus; includeArchived?: boolean };

function listWhere(ctx: TenantContext, f: PolicyFilters): Prisma.PolicyWhereInput {
  return {
    ...scope(ctx),
    ...(f.includeArchived ? {} : { archivedAt: null }),
    ...(f.status ? { status: f.status } : {}),
    ...(f.search
      ? {
          OR: [
            { name: { contains: f.search, mode: "insensitive" as const } },
            { description: { contains: f.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

export async function listPolicies(
  ctx: TenantContext,
  filters: PolicyFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where = listWhere(ctx, filters);

  const [rows, total] = await Promise.all([
    prisma.policy.findMany({
      where,
      orderBy: { name: "asc" },
      skip: page.skip,
      take: page.take,
      include: { _count: { select: { controls: true } } },
    }),
    prisma.policy.count({ where }),
  ]);

  const now = Date.now();
  return {
    total,
    items: rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      owner: p.owner,
      evidenceRef: p.evidenceRef,
      reviewDueAt: p.reviewDueAt,
      reviewOverdue: p.reviewDueAt !== null && p.reviewDueAt.getTime() < now,
      controlCount: p._count.controls,
      createdAt: p.createdAt,
      archivedAt: p.archivedAt,
    })),
  };
}

export async function getPolicyById(ctx: TenantContext, id: number) {
  const policy = await prisma.policy.findFirst({
    where: { id, ...scope(ctx) },
    include: { controls: { include: { control: true } } },
  });
  if (!policy) throw new NotFoundError(`Policy ${id} not found`);

  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    status: policy.status,
    owner: policy.owner,
    evidenceRef: policy.evidenceRef,
    reviewDueAt: policy.reviewDueAt,
    reviewOverdue: policy.reviewDueAt !== null && policy.reviewDueAt.getTime() < Date.now(),
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
    archivedAt: policy.archivedAt,
    controls: policy.controls.map((c) => ({
      id: c.control.id,
      name: c.control.name,
      category: c.control.category,
      status: c.control.status,
      effectiveness: c.control.effectiveness,
    })),
  };
}

export type PolicyWriteInput = {
  name: string;
  description: string;
  status?: PolicyStatus;
  owner?: string | null;
  evidenceRef?: string | null;
  reviewDueAt?: Date | null;
};

export async function createPolicy(ctx: TenantContext, input: PolicyWriteInput) {
  try {
    return await prisma.policy.create({ data: { ...input, organizationId: ctx.organizationId } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A policy named "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function updatePolicy(
  ctx: TenantContext,
  id: number,
  input: Partial<PolicyWriteInput>,
) {
  const policy = await prisma.policy.findFirst({ where: { id, ...scope(ctx) } });
  if (!policy) throw new NotFoundError(`Policy ${id} not found`);

  try {
    const after = await prisma.policy.update({ where: { id }, data: input });
    return { before: policy, after };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A policy named "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function archivePolicy(ctx: TenantContext, id: number) {
  const policy = await prisma.policy.findFirst({ where: { id, ...scope(ctx) } });
  if (!policy) throw new NotFoundError(`Policy ${id} not found`);
  if (policy.archivedAt) throw new ConflictError(`Policy ${id} is already archived`);

  return prisma.policy.update({
    where: { id },
    data: { archivedAt: new Date(), status: "ARCHIVED" },
  });
}

export async function setPolicyControl(
  ctx: TenantContext,
  policyId: number,
  controlId: number,
  linked: boolean,
) {
  const [policy, control] = await Promise.all([
    prisma.policy.findFirst({ where: { id: policyId, ...scope(ctx) }, select: { id: true } }),
    prisma.control.findFirst({ where: { id: controlId, ...scope(ctx) }, select: { id: true } }),
  ]);
  if (!policy) throw new NotFoundError(`Policy ${policyId} not found`);
  if (!control) throw new NotFoundError(`Control ${controlId} not found`);

  if (linked) {
    await prisma.policyControl.upsert({
      where: { policyId_controlId: { policyId, controlId } },
      create: { policyId, controlId },
      update: {},
    });
  } else {
    await prisma.policyControl.deleteMany({ where: { policyId, controlId } });
  }

  return { policyId, controlId, linked };
}
