import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { resetDatabase } from "../helpers.js";
import { demoEmail, seedDemo } from "../../prisma/seed-demo.js";

/**
 * The demo seed.
 *
 * Two properties matter and are tested separately: that it never destroys
 * anything, and that running it twice leaves the same database as running it
 * once. Both are easy to assert now and easy to break later, which is exactly
 * what a test is for -- the safety of this script is the whole reason it
 * exists rather than reusing `prisma/seed.ts`.
 *
 * These run against TEST_DATABASE_URL like every other integration test.
 */

const app = createApp();

/** The password the seed needs. Test-only, and never a real credential. */
const SEED_PASSWORD = "demo-seed-test-password";

beforeEach(async () => {
  await resetDatabase();
  process.env.DEMO_USER_PASSWORD = SEED_PASSWORD;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function census() {
  const [
    organizations, users, memberships, assets, phiTypes, assetPhi, dataFlows,
    risks, riskHistory, vendors, vendorRisks, vendorAccess, identities,
    accessGrants, threats, controls, assetControls, policies, policyControls,
    remediations, auditEvents,
  ] = await prisma.$transaction([
    prisma.organization.count(), prisma.user.count(), prisma.organizationMember.count(),
    prisma.asset.count(), prisma.pHIType.count(), prisma.assetPHI.count(),
    prisma.dataFlow.count(), prisma.risk.count(), prisma.riskHistory.count(),
    prisma.vendor.count(), prisma.vendorRisk.count(), prisma.vendorAssetAccess.count(),
    prisma.identity.count(), prisma.accessGrant.count(), prisma.threat.count(),
    prisma.control.count(), prisma.assetControl.count(), prisma.policy.count(),
    prisma.policyControl.count(), prisma.remediation.count(), prisma.auditEvent.count(),
  ]);
  return {
    organizations, users, memberships, assets, phiTypes, assetPhi, dataFlows,
    risks, riskHistory, vendors, vendorRisks, vendorAccess, identities,
    accessGrants, threats, controls, assetControls, policies, policyControls,
    remediations, auditEvents,
  };
}

describe("the seed is not destructive", () => {
  /**
   * The static guarantee. The whole point of this script is that it is safe to
   * point at a populated database, and the way that is achieved is by simply
   * not containing the operations that would destroy anything.
   */
  it("contains no destructive database operations", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../prisma/seed-demo.ts", import.meta.url),
      "utf8",
    );

    // Strip comments -- the file discusses these operations in prose to
    // explain their absence, and prose is not execution.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    for (const forbidden of [
      "deleteMany", ".delete(", "TRUNCATE", "DROP TABLE",
      "$executeRaw", "$queryRaw", "updateMany", "migrate reset",
    ]) {
      expect(code, `seed-demo.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("leaves records belonging to another organization untouched", async () => {
    // A pre-existing tenant with its own data, standing in for the customer
    // demo estate the seed must not disturb.
    const other = await prisma.organization.create({
      data: { name: "Existing Customer", slug: "existing-customer" },
    });
    const asset = await prisma.asset.create({
      data: {
        organizationId: other.id, name: "Existing Asset", type: "EHR",
        phiVolume: 1234, encrypted: true, mfaEnabled: true,
      },
    });
    const vendor = await prisma.vendor.create({
      data: { organizationId: other.id, name: "Existing Vendor", baaStatus: "SIGNED" },
    });

    await seedDemo({ quiet: true });

    const assetAfter = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    const vendorAfter = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });

    expect(assetAfter).toEqual(asset);
    expect(vendorAfter).toEqual(vendor);
    expect(await prisma.asset.count({ where: { organizationId: other.id } })).toBe(1);
    expect(await prisma.control.count({ where: { organizationId: other.id } })).toBe(0);
  });

  it("scopes everything it creates to its own organization", async () => {
    const other = await prisma.organization.create({
      data: { name: "Existing Customer", slug: "existing-customer" },
    });

    const { organizationId } = await seedDemo({ quiet: true });
    expect(organizationId).not.toBe(other.id);

    for (const count of await prisma.$transaction([
      prisma.asset.count({ where: { organizationId: { not: organizationId } } }),
      prisma.control.count({ where: { organizationId: { not: organizationId } } }),
      prisma.remediation.count({ where: { organizationId: { not: organizationId } } }),
    ])) {
      expect(count).toBe(0);
    }
  });
});

describe("the seed is idempotent", () => {
  it("creates the estate on the first run", async () => {
    const summary = await seedDemo({ quiet: true });

    expect(summary.created.assets).toBeGreaterThan(0);
    expect(summary.created.controls).toBeGreaterThan(0);
    expect(summary.created.policies).toBeGreaterThan(0);
    expect(summary.created.remediations).toBeGreaterThan(0);
    expect(summary.reused.assets ?? 0).toBe(0);
  });

  it("creates nothing on the second run", async () => {
    await seedDemo({ quiet: true });
    const second = await seedDemo({ quiet: true });

    // Every tallied entity must be "already present", not created again.
    const createdAgain = Object.entries(second.created).filter(([, n]) => n > 0);
    expect(createdAgain, `unexpectedly created: ${JSON.stringify(createdAgain)}`).toEqual([]);

    expect(second.reused.assets).toBeGreaterThan(0);
    expect(second.reused.controls).toBeGreaterThan(0);
  });

  /**
   * The assertion that would catch a regression the summary counters might
   * miss -- counts taken straight from the database rather than from the
   * seed's own bookkeeping.
   */
  it("does not change a single row count on the second run", async () => {
    await seedDemo({ quiet: true });
    const after1 = await census();

    await seedDemo({ quiet: true });
    const after2 = await census();

    expect(after2).toEqual(after1);
  });

  it("does not duplicate risk history, which has no unique constraint", async () => {
    await seedDemo({ quiet: true });
    const first = await prisma.riskHistory.count();

    await seedDemo({ quiet: true });
    expect(await prisma.riskHistory.count()).toBe(first);
  });

  it("does not duplicate audit events, which are append-only", async () => {
    await seedDemo({ quiet: true });
    const first = await prisma.auditEvent.count();

    await seedDemo({ quiet: true });
    expect(await prisma.auditEvent.count()).toBe(first);
  });

  it("survives three runs", async () => {
    await seedDemo({ quiet: true });
    const after1 = await census();
    await seedDemo({ quiet: true });
    await seedDemo({ quiet: true });

    expect(await census()).toEqual(after1);
  });
});

describe("the seeded estate is coherent", () => {
  beforeEach(async () => {
    await seedDemo({ quiet: true });
  });

  it("spans several risk bands, including the top one", async () => {
    const bands = await prisma.risk.groupBy({ by: ["band"], _count: { _all: true } });
    const byBand = Object.fromEntries(bands.map((b) => [b.band, b._count._all]));

    expect(Object.keys(byBand).length).toBeGreaterThanOrEqual(3);
    expect(byBand.LOW ?? 0).toBeGreaterThan(0);
    expect(byBand.MODERATE ?? 0).toBeGreaterThan(0);
    // Something has to be alarming, or the dashboard demonstrates nothing.
    expect((byBand.HIGH ?? 0) + (byBand.CRITICAL ?? 0) + (byBand.EXTREME ?? 0))
      .toBeGreaterThan(0);
  });

  /**
   * Scores must come from the engine, not from literals in the seed. If
   * someone later hardcodes them, the derived factors will stop agreeing with
   * the graph and this catches it.
   */
  it("derives risk from the graph rather than hardcoding it", async () => {
    const worst = await prisma.risk.findFirstOrThrow({
      orderBy: { score: "desc" },
      include: { asset: true },
    });

    // The worst asset should be the one that is actually worst: unencrypted,
    // no MFA, and holding a lot of PHI.
    expect(worst.asset.encrypted).toBe(false);
    expect(worst.asset.mfaEnabled).toBe(false);
    expect(worst.asset.phiVolume).toBeGreaterThan(100_000);
    expect(worst.exposure).toBe(5);
    expect(worst.controlGap).toBe(5);
  });

  it("gives every risk a history entry", async () => {
    const risks = await prisma.risk.count();
    const subjects = await prisma.riskHistory.groupBy({
      by: ["assetId"],
      where: { subjectType: "ASSET" },
    });
    expect(subjects.length).toBe(risks);
  });

  it("records vendor risk history too", async () => {
    const vendorEntries = await prisma.riskHistory.count({ where: { subjectType: "VENDOR" } });
    expect(vendorEntries).toBeGreaterThan(0);
  });

  it("links every remediation to a real record", async () => {
    const remediations = await prisma.remediation.findMany();
    expect(remediations.length).toBeGreaterThan(0);

    for (const r of remediations) {
      const linked =
        r.assetId ?? r.vendorId ?? r.threatId ?? r.controlId ?? r.identityId ?? r.accessGrantId;
      expect(linked, `"${r.title}" is an orphan`).not.toBeNull();
    }
  });

  it("covers the remediation states a demonstration needs", async () => {
    const byStatus = await prisma.remediation.groupBy({ by: ["status"], _count: { _all: true } });
    const statuses = new Set(byStatus.map((s) => s.status));

    expect(statuses.has("OPEN")).toBe(true);
    expect(statuses.has("IN_PROGRESS")).toBe(true);
    expect(statuses.has("RESOLVED")).toBe(true);
  });

  it("produces access findings across every flag the product detects", async () => {
    const grants = await prisma.accessGrant.findMany({
      include: { identity: true, asset: true },
    });

    expect(grants.some((g) => g.lastUsedAt === null)).toBe(true);
    expect(grants.some((g) => !g.identity.active)).toBe(true);
    expect(grants.some((g) => g.identity.kind === "USER" && !g.identity.mfaEnabled)).toBe(true);
    expect(grants.some((g) => g.level !== "READ" && g.asset.phiVolume > 50_000)).toBe(true);
  });

  it("serves the whole estate through the API", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: demoEmail("admin"), password: SEED_PASSWORD });

    expect(login.status).toBe(200);
    const token = login.body.data.token;

    for (const [path, minimum] of [
      ["/api/assets", 8], ["/api/vendors", 5], ["/api/controls", 8],
      ["/api/policies", 5], ["/api/remediations", 6], ["/api/risks", 8],
      ["/api/threats", 5], ["/api/access", 9], ["/api/identities", 6],
      ["/api/dataflows", 8], ["/api/risks/history", 10],
    ] as const) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status, path).toBe(200);
      expect(res.body.meta.total, path).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("never prints the demo password", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await seedDemo();
    } finally {
      console.log = original;
    }

    expect(lines.join("\n")).not.toContain(SEED_PASSWORD);
  });
});
