import { prisma } from "../lib/prisma.js";
import { scope, type TenantContext } from "../lib/tenant.js";

/**
 * Global search across the entities a user navigates by name.
 *
 * Bounded by construction: a minimum query length, a hard per-type cap, and a
 * hard overall cap. There is deliberately no "search everything" mode — an
 * unbounded cross-table scan is a denial-of-service primitive handed to any
 * authenticated user.
 *
 * Every query carries the tenant scope, so search cannot become the hole that
 * the scoped list endpoints closed.
 */

export const MIN_QUERY_LENGTH = 2;
const PER_TYPE_LIMIT = 10;
const MAX_RESULTS = 50;

export type SearchType =
  | "asset" | "vendor" | "identity" | "threat" | "remediation" | "control" | "policy";

export type SearchHit = {
  type: SearchType;
  id: number;
  title: string;
  /** Band, status or state — whatever the type's primary signal is. */
  status: string | null;
  context: string;
};

export type SearchOptions = { types?: SearchType[]; limit?: number };

export async function globalSearch(
  ctx: TenantContext,
  query: string,
  options: SearchOptions = {},
): Promise<{ query: string; results: SearchHit[]; truncated: boolean }> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return { query: q, results: [], truncated: false };
  }

  const want = (t: SearchType) => !options.types || options.types.includes(t);
  const contains = { contains: q, mode: "insensitive" as const };
  const take = PER_TYPE_LIMIT;

  const [assets, vendors, identities, threats, remediations, controls, policies] =
    await Promise.all([
      want("asset")
        ? prisma.asset.findMany({
            where: { ...scope(ctx), archivedAt: null, name: contains },
            take,
            include: { risks: { select: { band: true, score: true } } },
          })
        : [],
      want("vendor")
        ? prisma.vendor.findMany({
            where: { ...scope(ctx), archivedAt: null, name: contains },
            take,
          })
        : [],
      want("identity")
        ? prisma.identity.findMany({
            where: {
              ...scope(ctx), archivedAt: null,
              OR: [{ displayName: contains }, { email: contains }],
            },
            take,
          })
        : [],
      want("threat")
        ? prisma.threat.findMany({
            where: { ...scope(ctx), title: contains },
            take,
            include: { asset: { select: { name: true } } },
          })
        : [],
      want("remediation")
        ? prisma.remediation.findMany({ where: { ...scope(ctx), title: contains }, take })
        : [],
      want("control")
        ? prisma.control.findMany({
            where: { ...scope(ctx), archivedAt: null, name: contains },
            take,
          })
        : [],
      want("policy")
        ? prisma.policy.findMany({
            where: { ...scope(ctx), archivedAt: null, name: contains },
            take,
          })
        : [],
    ]);

  const results: SearchHit[] = [
    ...assets.map((a): SearchHit => ({
      type: "asset", id: a.id, title: a.name,
      status: a.risks[0]?.band ?? null,
      context: `${a.type} · ${a.phiVolume.toLocaleString()} PHI records`,
    })),
    ...vendors.map((v): SearchHit => ({
      type: "vendor", id: v.id, title: v.name, status: v.baaStatus,
      context: `BAA ${v.baaStatus} · ${v.phiVolume.toLocaleString()} PHI records`,
    })),
    ...identities.map((i): SearchHit => ({
      type: "identity", id: i.id, title: i.displayName,
      status: i.active ? "ACTIVE" : "INACTIVE",
      context: [i.kind, i.department].filter(Boolean).join(" · "),
    })),
    ...threats.map((t): SearchHit => ({
      type: "threat", id: t.id, title: t.title, status: t.status,
      context: `${t.severity} · ${t.asset.name}`,
    })),
    ...remediations.map((r): SearchHit => ({
      type: "remediation", id: r.id, title: r.title, status: r.status,
      context: `${r.severity} · ${r.source}`,
    })),
    ...controls.map((c): SearchHit => ({
      type: "control", id: c.id, title: c.name, status: c.status,
      context: `${c.category} · ${c.effectiveness}`,
    })),
    ...policies.map((p): SearchHit => ({
      type: "policy", id: p.id, title: p.name, status: p.status,
      context: p.owner ? `Owner: ${p.owner}` : "Unassigned",
    })),
  ];

  const limit = Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS);
  return {
    query: q,
    results: results.slice(0, limit),
    truncated: results.length > limit,
  };
}
