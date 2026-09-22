import type {
  ControlCategory, ControlEffectiveness, ControlStatus, Prisma,
} from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { isUniqueViolation } from "./assetService.js";

/**
 * Controls: the safeguards an organisation actually operates.
 *
 * This is the half of the risk model that was missing. `controlGap` has always
 * been an assessor's 1-5 judgement; a Control record is what that judgement is
 * meant to be argued from. The link is evidential, not automatic — see
 * `controlGapEvidence` below for exactly how far it goes and why it stops
 * there.
 *
 * `frameworkRef` is free text the customer typed. Drishti stores it as a
 * reference and asserts nothing about compliance on the strength of it.
 */

export type ControlFilters = {
  search?: string;
  category?: ControlCategory;
  status?: ControlStatus;
  effectiveness?: ControlEffectiveness;
  includeArchived?: boolean;
};

function listWhere(ctx: TenantContext, filters: ControlFilters): Prisma.ControlWhereInput {
  return {
    ...scope(ctx),
    ...(filters.includeArchived ? {} : { archivedAt: null }),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.effectiveness ? { effectiveness: filters.effectiveness } : {}),
    ...(filters.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: "insensitive" as const } },
            { description: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

export async function listControls(
  ctx: TenantContext,
  filters: ControlFilters = {},
  page: { skip?: number; take?: number } = {},
) {
  const where = listWhere(ctx, filters);

  const [rows, total] = await Promise.all([
    prisma.control.findMany({
      where,
      orderBy: [{ category: "asc" }, { name: "asc" }],
      skip: page.skip,
      take: page.take,
      include: {
        _count: {
          select: {
            assets: true,
            policies: true,
            remediations: { where: { status: { not: "RESOLVED" } } },
          },
        },
      },
    }),
    prisma.control.count({ where }),
  ]);

  return {
    total,
    items: rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      category: c.category,
      status: c.status,
      effectiveness: c.effectiveness,
      owner: c.owner,
      frameworkRef: c.frameworkRef,
      lastReviewedAt: c.lastReviewedAt,
      createdAt: c.createdAt,
      archivedAt: c.archivedAt,
      appliedAssetCount: c._count.assets,
      policyCount: c._count.policies,
      openRemediations: c._count.remediations,
    })),
  };
}

export async function getControlById(ctx: TenantContext, id: number) {
  const control = await prisma.control.findFirst({
    where: { id, ...scope(ctx) },
    include: {
      assets: {
        take: 200,
        include: { asset: { select: { id: true, name: true, type: true, phiVolume: true } } },
      },
      policies: { include: { policy: { select: { id: true, name: true, status: true } } } },
      remediations: {
        take: 100,
        where: { status: { not: "RESOLVED" } },
        orderBy: { severity: "desc" },
      },
    },
  });
  if (!control) throw new NotFoundError(`Control ${id} not found`);

  return {
    id: control.id,
    name: control.name,
    description: control.description,
    category: control.category,
    status: control.status,
    effectiveness: control.effectiveness,
    owner: control.owner,
    frameworkRef: control.frameworkRef,
    lastReviewedAt: control.lastReviewedAt,
    createdAt: control.createdAt,
    updatedAt: control.updatedAt,
    archivedAt: control.archivedAt,
    assets: control.assets.map((a) => ({
      id: a.asset.id, name: a.asset.name, type: a.asset.type,
      phiVolume: a.asset.phiVolume, linkedAt: a.createdAt,
    })),
    policies: control.policies.map((p) => ({
      id: p.policy.id, name: p.policy.name, status: p.policy.status,
    })),
    remediations: control.remediations.map((r) => ({
      id: r.id, title: r.title, severity: r.severity, status: r.status, dueAt: r.dueAt,
    })),
    /** PHI protected by this control, summed over the assets it is applied to. */
    phiCovered: control.assets.reduce((sum, a) => sum + a.asset.phiVolume, 0),
  };
}

export type ControlWriteInput = {
  name: string;
  description: string;
  category: ControlCategory;
  status?: ControlStatus;
  effectiveness?: ControlEffectiveness;
  owner?: string | null;
  frameworkRef?: string | null;
  lastReviewedAt?: Date | null;
};

export async function createControl(ctx: TenantContext, input: ControlWriteInput) {
  try {
    return await prisma.control.create({
      data: { ...input, organizationId: ctx.organizationId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A control named "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function updateControl(
  ctx: TenantContext,
  id: number,
  input: Partial<ControlWriteInput>,
) {
  const control = await prisma.control.findFirst({ where: { id, ...scope(ctx) } });
  if (!control) throw new NotFoundError(`Control ${id} not found`);

  try {
    const after = await prisma.control.update({ where: { id }, data: input });
    return { before: control, after };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A control named "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function archiveControl(ctx: TenantContext, id: number) {
  const control = await prisma.control.findFirst({ where: { id, ...scope(ctx) } });
  if (!control) throw new NotFoundError(`Control ${id} not found`);
  if (control.archivedAt) throw new ConflictError(`Control ${id} is already archived`);

  return prisma.control.update({ where: { id }, data: { archivedAt: new Date() } });
}

/** Applies or removes a control on an asset. */
export async function setAssetControl(
  ctx: TenantContext,
  controlId: number,
  assetId: number,
  applied: boolean,
) {
  const [control, asset] = await Promise.all([
    prisma.control.findFirst({ where: { id: controlId, ...scope(ctx) }, select: { id: true } }),
    prisma.asset.findFirst({ where: { id: assetId, ...scope(ctx) }, select: { id: true } }),
  ]);
  if (!control) throw new NotFoundError(`Control ${controlId} not found`);
  if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);

  if (applied) {
    await prisma.assetControl.upsert({
      where: { assetId_controlId: { assetId, controlId } },
      create: { assetId, controlId },
      update: {},
    });
  } else {
    await prisma.assetControl.deleteMany({ where: { assetId, controlId } });
  }

  return { controlId, assetId, applied };
}

/**
 * Control coverage for one asset, as *evidence for* a control-gap judgement —
 * not as a substitute for one.
 *
 * `suggestedControlGap` is a transparent arithmetic mapping of how many
 * applied controls are assessed effective, offered so an assessor has a
 * defensible starting number. It is **never written to Risk automatically**:
 * the four risk inputs stay human judgement, and a score that moved because a
 * checkbox changed would be a number nobody could defend in an audit.
 *
 * The caller decides whether to accept it via POST /api/assets/:id/assessment.
 */
export async function controlGapEvidence(ctx: TenantContext, assetId: number) {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, ...scope(ctx) },
    include: { controls: { include: { control: true } } },
  });
  if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);

  const applied = asset.controls.map((c) => c.control);
  const effective = applied.filter(
    (c) => c.effectiveness === "EFFECTIVE" && c.status === "IMPLEMENTED",
  );
  const partial = applied.filter(
    (c) => c.effectiveness === "PARTIALLY_EFFECTIVE" || c.status === "PARTIAL",
  );

  // Weighted coverage: an effective control counts fully, a partial one half.
  const weighted = effective.length + partial.length * 0.5;

  // Mapped onto the 1-5 control-gap scale, 5 being "no effective control".
  // Five thresholds, stated plainly so the UI can show the working.
  const suggestedControlGap =
    weighted >= 4 ? 1 : weighted >= 3 ? 2 : weighted >= 2 ? 3 : weighted >= 1 ? 4 : 5;

  return {
    assetId,
    appliedControls: applied.length,
    effectiveControls: effective.length,
    partialControls: partial.length,
    weightedCoverage: weighted,
    suggestedControlGap,
    /** Explicit so no caller mistakes this for something already applied. */
    applied: false,
    basis: "Weighted count of applied controls that are IMPLEMENTED and EFFECTIVE (1.0) or PARTIAL/PARTIALLY_EFFECTIVE (0.5).",
    controls: applied.map((c) => ({
      id: c.id, name: c.name, category: c.category,
      status: c.status, effectiveness: c.effectiveness,
    })),
  };
}
