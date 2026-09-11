import { prisma } from "../lib/prisma.js";
import { flowStatus } from "./flowStatus.js";

export { flowStatus, type FlowStatus } from "./flowStatus.js";

/**
 * Every PHI movement, shaped for the Sankey: asset *names* rather than ids
 * (the chart labels its nodes directly), recordsPerDay driving ribbon width,
 * and status driving ribbon tone.
 */
export async function listDataFlows() {
  const flows = await prisma.dataFlow.findMany({
    orderBy: { recordsPerDay: "desc" },
    include: {
      sourceAsset: { select: { name: true } },
      targetAsset: { select: { name: true, mfaEnabled: true } },
      phiType: { select: { name: true } },
    },
  });

  return flows.map((flow) => ({
    id: flow.id,
    source: flow.sourceAsset.name,
    target: flow.targetAsset.name,
    phiType: flow.phiType.name,
    recordsPerDay: flow.recordsPerDay,
    encrypted: flow.encrypted,
    status: flowStatus(flow.encrypted, flow.targetAsset.mfaEnabled),
  }));
}
