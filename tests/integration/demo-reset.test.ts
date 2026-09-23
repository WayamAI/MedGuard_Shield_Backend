import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { resetDatabase } from "../helpers.js";
import { seedDemo, DEMO_ORG_SLUG } from "../../prisma/seed-demo.js";
import { resetDemo } from "../../prisma/reset-demo.js";

/**
 * The scoped demo reset.
 *
 * Unlike `seed-demo.ts`, this command genuinely deletes — so the tests that
 * matter most are the ones proving it deletes nothing outside the demo
 * organisation, and that what it leaves behind is the same every time.
 *
 * These run against TEST_DATABASE_URL like every other integration test.
 */

const app = createApp();

const SEED_PASSWORD = "demo-reset-test-password";

beforeEach(async () => {
  await resetDatabase();
  process.env.DEMO_USER_PASSWORD = SEED_PASSWORD;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Everything in the demo organisation, counted from the database. */
async function demoCensus(organizationId: number) {
  const [
    assets, phiTypes, assetPhi, dataFlows, identities, accessGrants, vendors,
    vendorRisks, vendorAccess, threats, controls, assetControls, policies,
    policyControls, remediations, risks, riskHistory, auditEvents, members,
  ] = await prisma.$transaction([
    prisma.asset.count({ where: { organizationId } }),
    prisma.pHIType.count({ where: { organizationId } }),
    prisma.assetPHI.count({ where: { asset: { organizationId } } }),
    prisma.dataFlow.count({ where: { organizationId } }),
    prisma.identity.count({ where: { organizationId } }),
    prisma.accessGrant.count({ where: { organizationId } }),
    prisma.vendor.count({ where: { organizationId } }),
    prisma.vendorRisk.count({ where: { organizationId } }),
    prisma.vendorAssetAccess.count({ where: { vendor: { organizationId } } }),
    prisma.threat.count({ where: { organizationId } }),
    prisma.control.count({ where: { organizationId } }),
    prisma.assetControl.count({ where: { asset: { organizationId } } }),
    prisma.policy.count({ where: { organizationId } }),
    prisma.policyControl.count({ where: { policy: { organizationId } } }),
    prisma.remediation.count({ where: { organizationId } }),
    prisma.risk.count({ where: { organizationId } }),
    prisma.riskHistory.count({ where: { organizationId } }),
    prisma.auditEvent.count({ where: { organizationId } }),
    prisma.organizationMember.count({ where: { organizationId } }),
  ]);
  return {
    assets, phiTypes, assetPhi, dataFlows, identities, accessGrants, vendors,
    vendorRisks, vendorAccess, threats, controls, assetControls, policies,
    policyControls, remediations, risks, riskHistory, auditEvents, members,
  };
}

/** A second tenant holding its own data, standing in for the customer estate. */
async function seedRival() {
  const org = await prisma.organization.create({
    data: { name: "Rival Health", slug: "rival-health" },
  });
  const asset = await prisma.asset.create({
    data: {
      organizationId: org.id, name: "Rival EHR", type: "EHR",
      phiVolume: 4321, encrypted: true, mfaEnabled: true,
    },
  });
  const vendor = await prisma.vendor.create({
    data: { organizationId: org.id, name: "Rival Vendor", baaStatus: "SIGNED" },
  });
  const control = await prisma.control.create({
    data: {
      organizationId: org.id, name: "Rival Control", description: "d",
      category: "ACCESS", status: "IMPLEMENTED", effectiveness: "EFFECTIVE",
    },
  });
  await prisma.assetControl.create({ data: { assetId: asset.id, controlId: control.id } });
  const remediation = await prisma.remediation.create({
    data: {
      organizationId: org.id, title: "Rival finding", description: "d",
      recommendation: "r", assetId: asset.id,
    },
  });
  const audit = await prisma.auditEvent.create({
    data: { organizationId: org.id, action: "ASSET_CREATED", entityType: "Asset", entityId: asset.id },
  });
  // A tenant-less row, which belongs to no organisation and must also survive.
  const orphanAudit = await prisma.auditEvent.create({ data: { action: "LOGIN_FAILED" } });

  return { org, asset, vendor, control, remediation, audit, orphanAudit };
}

describe("the reset is confined to the demo organization", () => {
  /**
   * This file necessarily contains `deleteMany`, which is the whole point of
   * it. What it must never contain is an *unscoped* delete, or raw SQL that
   * sidesteps the scoping entirely.
   */
  it("contains no raw SQL, no truncate, and no unscoped delete", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../prisma/reset-demo.ts", import.meta.url),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    for (const forbidden of [
      "TRUNCATE", "DROP TABLE", "$executeRaw", "$queryRaw", "migrate reset",
      "deleteMany()", "updateMany",
    ]) {
      expect(code, `reset-demo.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }

    // Every delete must carry a where clause. If those two counts ever differ,
    // one of them is unscoped.
    const deletes = code.match(/\.deleteMany\(/g) ?? [];
    const scoped = code.match(/\.deleteMany\(\{ where:/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    expect(scoped.length, "every deleteMany must be scoped by a where clause")
      .toBe(deletes.length);
  });

  it("leaves another organization's records byte-identical", async () => {
    const rival = await seedRival();
    await seedDemo({ quiet: true });

    await resetDemo({ quiet: true });

    expect(await prisma.asset.findUnique({ where: { id: rival.asset.id } })).toEqual(rival.asset);
    expect(await prisma.vendor.findUnique({ where: { id: rival.vendor.id } })).toEqual(rival.vendor);
    expect(await prisma.control.findUnique({ where: { id: rival.control.id } })).toEqual(rival.control);
    expect(await prisma.remediation.findUnique({ where: { id: rival.remediation.id } }))
      .toEqual(rival.remediation);
    expect(await prisma.auditEvent.findUnique({ where: { id: rival.audit.id } })).toEqual(rival.audit);
    expect(await prisma.assetControl.count({ where: { asset: { organizationId: rival.org.id } } })).toBe(1);
  });

  it("leaves audit events that belong to no organization alone", async () => {
    const rival = await seedRival();
    await seedDemo({ quiet: true });

    await resetDemo({ quiet: true });

    expect(await prisma.auditEvent.findUnique({ where: { id: rival.orphanAudit.id } }))
      .toEqual(rival.orphanAudit);
  });

  it("keeps the organization row and the demo accounts", async () => {
    const first = await seedDemo({ quiet: true });
    const usersBefore = await prisma.user.findMany({ orderBy: { id: "asc" } });

    const result = await resetDemo({ quiet: true });

    // The same organisation, not a replacement with a new id.
    expect(result.organizationId).toBe(first.organizationId);
    expect(await prisma.user.findMany({ orderBy: { id: "asc" } })).toEqual(usersBefore);
    expect(await prisma.organizationMember.count({ where: { organizationId: first.organizationId } }))
      .toBe(3);
  });

  it("refuses to run against NODE_ENV=production without an explicit override", async () => {
    await seedDemo({ quiet: true });
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(resetDemo({ quiet: true })).rejects.toThrow(/NODE_ENV=production/);
      // Nothing was removed by the refusal.
      expect(await prisma.asset.count()).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("seeds from nothing when the demo organization does not exist", async () => {
    expect(await prisma.organization.count({ where: { slug: DEMO_ORG_SLUG } })).toBe(0);

    const result = await resetDemo({ quiet: true });

    expect(result.deleted).toEqual({});
    expect(await prisma.asset.count({ where: { organizationId: result.organizationId! } }))
      .toBeGreaterThan(0);
  });
});

describe("the reset removes drift and is deterministic", () => {
  it("removes records added to the demo organization since the last seed", async () => {
    const { organizationId } = await seedDemo({ quiet: true });

    // Stand-ins for exactly the artifacts a release verification leaves behind.
    const strayAsset = await prisma.asset.create({
      data: { organizationId, name: "ZZ-PROBE-asset", type: "API" },
    });
    const strayVendor = await prisma.vendor.create({
      data: { organizationId, name: "ZZ-PROBE-vendor" },
    });
    const strayRemediation = await prisma.remediation.create({
      data: {
        organizationId, title: "ZZ-PROBE remediation", description: "d", recommendation: "r",
      },
    });
    const strayAudit = await prisma.auditEvent.create({
      data: { organizationId, action: "ASSET_CREATED", entityType: "Asset", entityId: strayAsset.id },
    });

    await resetDemo({ quiet: true });

    expect(await prisma.asset.findUnique({ where: { id: strayAsset.id } })).toBeNull();
    expect(await prisma.vendor.findUnique({ where: { id: strayVendor.id } })).toBeNull();
    expect(await prisma.remediation.findUnique({ where: { id: strayRemediation.id } })).toBeNull();
    expect(await prisma.auditEvent.findUnique({ where: { id: strayAudit.id } })).toBeNull();
    expect(await prisma.asset.count({ where: { organizationId, name: { startsWith: "ZZ-PROBE" } } }))
      .toBe(0);
  });

  it("reports what it removed", async () => {
    await seedDemo({ quiet: true });
    const result = await resetDemo({ quiet: true });

    expect(result.deleted.asset).toBeGreaterThan(0);
    expect(result.deleted.remediation).toBeGreaterThan(0);
    expect(result.deleted.auditEvent).toBeGreaterThan(0);
  });

  it("produces the same dataset twice running", async () => {
    const first = await resetDemo({ quiet: true });
    const censusA = await demoCensus(first.organizationId!);

    const second = await resetDemo({ quiet: true });
    const censusB = await demoCensus(second.organizationId!);

    expect(censusB).toEqual(censusA);
  });

  /**
   * Counts alone would pass even if the scores had all moved, so the scores
   * themselves are compared — they are what a demonstration actually shows.
   */
  it("produces the same risk scores twice running", async () => {
    const readScores = async (organizationId: number) =>
      (await prisma.risk.findMany({
        where: { organizationId },
        select: { score: true, band: true, asset: { select: { name: true } } },
        orderBy: { asset: { name: "asc" } },
      }));

    const first = await resetDemo({ quiet: true });
    const before = await readScores(first.organizationId!);

    const second = await resetDemo({ quiet: true });
    expect(await readScores(second.organizationId!)).toEqual(before);
  });

  it("does not duplicate anything after a reset followed by a plain seed", async () => {
    const { organizationId } = await resetDemo({ quiet: true });
    const census = await demoCensus(organizationId!);

    const again = await seedDemo({ quiet: true });
    expect(Object.entries(again.created).filter(([, n]) => n > 0)).toEqual([]);
    expect(await demoCensus(organizationId!)).toEqual(census);
  });
});

describe("the reset demo environment is presentation-ready", () => {
  let organizationId: number;

  beforeEach(async () => {
    const result = await resetDemo({ quiet: true });
    organizationId = result.organizationId!;
  });

  /** The band coverage a demonstration needs, asserted rather than assumed. */
  it("covers every risk band the product displays", async () => {
    const rows = await prisma.risk.groupBy({
      by: ["band"], where: { organizationId }, _count: { _all: true },
    });
    const byBand = Object.fromEntries(rows.map((r) => [r.band, r._count._all]));

    expect(byBand.CRITICAL ?? 0).toBeGreaterThanOrEqual(1);
    expect(byBand.HIGH ?? 0).toBeGreaterThanOrEqual(2);
    expect(byBand.MODERATE ?? 0).toBeGreaterThanOrEqual(2);
    expect(byBand.LOW ?? 0).toBeGreaterThanOrEqual(2);
  });

  /**
   * The CRITICAL entry must earn its band from the graph. If someone later
   * hardcodes a score, the derived factors stop agreeing with the facts and
   * this fails.
   */
  it("derives the critical risk from real graph facts", async () => {
    const critical = await prisma.risk.findFirstOrThrow({
      where: { organizationId, band: "CRITICAL" },
      include: { asset: { include: { accessGrants: true, vendorAccess: true } } },
    });

    expect(critical.asset.encrypted).toBe(false);
    expect(critical.asset.mfaEnabled).toBe(false);
    expect(critical.asset.phiVolume).toBeGreaterThan(200_000);
    expect(critical.asset.accessGrants.length).toBeGreaterThan(3);
    expect(critical.asset.vendorAccess.length).toBeGreaterThan(0);
    // A control gap below the maximum is what separates CRITICAL from EXTREME:
    // something is protecting it, just not enough.
    expect(critical.controlGap).toBeLessThan(5);
    expect(critical.exposure).toBe(5);
  });

  it("covers the remediation states a demonstration needs", async () => {
    const rows = await prisma.remediation.groupBy({
      by: ["status"], where: { organizationId }, _count: { _all: true },
    });
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));

    for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED"]) {
      expect(byStatus[status] ?? 0, `expected at least one ${status} remediation`)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it("shows both an open and a closed threat", async () => {
    const open = await prisma.threat.count({
      where: { organizationId, status: { in: ["OPEN", "INVESTIGATING"] } },
    });
    const closed = await prisma.threat.count({
      where: { organizationId, status: "RESOLVED" },
    });
    expect(open).toBeGreaterThanOrEqual(1);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it("shows a vendor exposure, an access finding and a control gap", async () => {
    // A vendor without a signed BAA that can reach PHI.
    expect(await prisma.vendor.count({
      where: { organizationId, baaStatus: { not: "SIGNED" }, assetAccess: { some: {} } },
    })).toBeGreaterThanOrEqual(1);

    // A live grant held by a deactivated identity.
    expect(await prisma.accessGrant.count({
      where: { organizationId, revokedAt: null, identity: { active: false } },
    })).toBeGreaterThanOrEqual(1);

    // A control that is in place but not working.
    expect(await prisma.control.count({
      where: { organizationId, effectiveness: { in: ["INEFFECTIVE", "NOT_ASSESSED"] } },
    })).toBeGreaterThanOrEqual(1);
  });

  it("carries a movement history for both assets and vendors", async () => {
    expect(await prisma.riskHistory.count({ where: { organizationId, subjectType: "ASSET" } }))
      .toBeGreaterThan(0);
    expect(await prisma.riskHistory.count({ where: { organizationId, subjectType: "VENDOR" } }))
      .toBeGreaterThan(0);
  });

  it("carries an audit trail describing product activity, not seeding", async () => {
    const rows = await prisma.auditEvent.groupBy({
      by: ["action"], where: { organizationId }, _count: { _all: true },
    });
    const actions = new Set(rows.map((r) => r.action));

    for (const action of [
      "ASSET_CREATED", "VENDOR_CREATED", "RISK_CREATED",
      "THREAT_CREATED", "ACCESS_REVIEWED", "CONTROL_UPDATED", "REMEDIATION_CREATED",
    ] as const) {
      expect(actions.has(action), `expected a ${action} event`).toBe(true);
    }

    // Backdated, so the trail reads as history rather than a burst at seed time.
    const oldest = await prisma.auditEvent.findFirstOrThrow({
      where: { organizationId }, orderBy: { createdAt: "asc" },
    });
    expect(oldest.createdAt.getTime()).toBeLessThan(Date.now() - 30 * 24 * 60 * 60 * 1000);
  });

  /** The customer smoke test: every surface a demonstration opens. */
  it("serves real data on every endpoint a demonstration uses", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: `admin@${DEMO_ORG_SLUG}.invalid`, password: SEED_PASSWORD });
    expect(login.status).toBe(200);
    const token = login.body.data.token;

    for (const [path, minimum] of [
      ["/api/assets", 12], ["/api/risks", 12], ["/api/vendors", 5],
      ["/api/access", 20], ["/api/threats", 7], ["/api/controls", 8],
      ["/api/policies", 5], ["/api/remediations", 9], ["/api/identities", 6],
      ["/api/dataflows", 13], ["/api/audit", 13], ["/api/risks/history", 30],
    ] as const) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status, path).toBe(200);
      expect(res.body.meta.total, path).toBeGreaterThanOrEqual(minimum);
    }

    const report = await request(app)
      .get("/api/reports/risk-assessment")
      .set("Authorization", `Bearer ${token}`);
    expect(report.status).toBe(200);
    expect(report.body.data.assets.total).toBe(12);
    expect(report.body.data.assets.assessmentCoverage).toBe(100);
  });

  it("never prints the demo password", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await resetDemo();
    } finally {
      console.log = original;
    }
    expect(lines.join("\n")).not.toContain(SEED_PASSWORD);
  });
});
