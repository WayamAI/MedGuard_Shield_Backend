import type { ThreatSeverity, ThreatStatus } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

/** Worst first, so the feed opens on what needs attention. */
const SEVERITY_ORDER: Record<ThreatSeverity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

/**
 * Still needs a human. OPEN and INVESTIGATING rank equally here on purpose:
 * ordering by the finer-grained status would push an OPEN low-severity item
 * above an INVESTIGATING critical, which is backwards for a triage feed.
 */
const OPEN_STATUSES: ThreatStatus[] = ["OPEN", "INVESTIGATING"];

function hoursSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 3_600_000);
}

export async function listThreats() {
  const threats = await prisma.threat.findMany({
    include: { asset: { select: { id: true, name: true, type: true } } },
  });

  const rows = threats
    .map((t) => ({
      id: t.id,
      severity: t.severity,
      status: t.status,
      title: t.title,
      description: t.description,
      assetId: t.asset.id,
      assetName: t.asset.name,
      assetType: t.asset.type,
      detectedAt: t.detectedAt,
      resolvedAt: t.resolvedAt,
      hoursSinceDetection: hoursSince(t.detectedAt),
      // Whether this still needs someone, which is what the feed filters on.
      open: OPEN_STATUSES.includes(t.status),
    }))
    .sort((a, b) => {
      // Unresolved first, then worst severity, then most recent.
      if (a.open !== b.open) return a.open ? -1 : 1;
      const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (bySeverity !== 0) return bySeverity;
      return b.detectedAt.getTime() - a.detectedAt.getTime();
    });

  const summary = {
    total: rows.length,
    open: rows.filter((r) => r.open).length,
    bySeverity: {
      CRITICAL: rows.filter((r) => r.severity === "CRITICAL").length,
      HIGH: rows.filter((r) => r.severity === "HIGH").length,
      MEDIUM: rows.filter((r) => r.severity === "MEDIUM").length,
      LOW: rows.filter((r) => r.severity === "LOW").length,
    },
    byStatus: {
      OPEN: rows.filter((r) => r.status === "OPEN").length,
      INVESTIGATING: rows.filter((r) => r.status === "INVESTIGATING").length,
      RESOLVED: rows.filter((r) => r.status === "RESOLVED").length,
      FALSE_POSITIVE: rows.filter((r) => r.status === "FALSE_POSITIVE").length,
    },
    // The number a dashboard leads with.
    openCritical: rows.filter((r) => r.open && r.severity === "CRITICAL").length,
  };

  return { summary, threats: rows };
}
