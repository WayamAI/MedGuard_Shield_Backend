import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../lib/errors.js";
import { scope, type TenantContext } from "../lib/tenant.js";
import { flowStatus } from "./flowStatus.js";

export { flowStatus, type FlowStatus } from "./flowStatus.js";

export type DataFlowFilters = { status?: "ok" | "warn" | "violation"; assetId?: number };

/**
 * Every PHI movement, shaped for the Sankey: asset *names* rather than ids
 * (the chart labels its nodes directly), recordsPerDay driving ribbon width,
 * and status driving ribbon tone.
 *
 * `status` is derived, not stored, so filtering on it cannot be pushed into
 * SQL. The filter is therefore applied after the fetch and, when present,
 * pagination is applied to the filtered set — which is why the query runs
 * unpaginated in that one case. Bounded by the tenant's flow count, which is
 * an order of magnitude smaller than its access register.
 */
export async function listDataFlows(
  ctx: TenantContext,
  filters: DataFlowFilters = {},
  page: { skip?: number; take?: number } = {},
): Promise<{ items: ReturnType<typeof shape>[]; total: number }> {
  const where: Prisma.DataFlowWhereInput = {
    ...scope(ctx),
    ...(filters.assetId
      ? { OR: [{ sourceAssetId: filters.assetId }, { targetAssetId: filters.assetId }] }
      : {}),
  };

  const include = {
    sourceAsset: { select: { id: true, name: true } },
    targetAsset: { select: { id: true, name: true, mfaEnabled: true } },
    phiType: { select: { id: true, name: true, sensitivity: true } },
  } as const;

  if (filters.status) {
    const all = await prisma.dataFlow.findMany({ where, orderBy: { recordsPerDay: "desc" }, include });
    const matched = all.map(shape).filter((f) => f.status === filters.status);
    const start = page.skip ?? 0;
    const end = page.take === undefined ? undefined : start + page.take;
    return { items: matched.slice(start, end), total: matched.length };
  }

  const [rows, total] = await Promise.all([
    prisma.dataFlow.findMany({
      where,
      orderBy: { recordsPerDay: "desc" },
      skip: page.skip,
      take: page.take,
      include,
    }),
    prisma.dataFlow.count({ where }),
  ]);

  return { items: rows.map(shape), total };
}

type FlowRow = {
  id: number;
  recordsPerDay: number;
  encrypted: boolean;
  sourceAsset: { id: number; name: string };
  targetAsset: { id: number; name: string; mfaEnabled: boolean };
  phiType: { id: number; name: string; sensitivity: string };
};

function shape(flow: FlowRow) {
  return {
    id: flow.id,
    source: flow.sourceAsset.name,
    sourceAssetId: flow.sourceAsset.id,
    target: flow.targetAsset.name,
    targetAssetId: flow.targetAsset.id,
    phiType: flow.phiType.name,
    phiTypeId: flow.phiType.id,
    sensitivity: flow.phiType.sensitivity,
    recordsPerDay: flow.recordsPerDay,
    encrypted: flow.encrypted,
    status: flowStatus(flow.encrypted, flow.targetAsset.mfaEnabled),
  };
}

export async function getDataFlowById(ctx: TenantContext, id: number) {
  const flow = await prisma.dataFlow.findFirst({
    where: { id, ...scope(ctx) },
    include: {
      sourceAsset: { select: { id: true, name: true } },
      targetAsset: { select: { id: true, name: true, mfaEnabled: true } },
      phiType: { select: { id: true, name: true, sensitivity: true } },
    },
  });
  if (!flow) throw new NotFoundError(`Data flow ${id} not found`);
  return shape(flow);
}
