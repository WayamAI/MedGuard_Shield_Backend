import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { main as seedMeridian } from "../../prisma/seed.js";

/**
 * Proves the Meridian Health System seed (`prisma/seed.ts`, `npm run
 * db:seed`) — the one the CEO-walkthrough demo actually uses — produces
 * every headline fact the demo script relies on. Distinct from
 * `demo-seed.test.ts` / `demo-reset.test.ts`, which cover the *other*,
 * unrelated "Drishti Demo Healthcare" seed (`seed-demo.ts`).
 *
 * Runs against its own database (vitest.meridian-seed.config.ts) because
 * `prisma/seed.ts` TRUNCATEs core tables outright.
 */

beforeAll(async () => {
  await seedMeridian();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("production safety", () => {
  it("refuses to run with NODE_ENV=production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(seedMeridian()).rejects.toThrow(/Refusing to run this destructive demo seed/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("runs with NODE_ENV=production only when explicitly overridden", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.SEED_ALLOW_PRODUCTION = "yes";
    try {
      await expect(seedMeridian()).resolves.toBeUndefined();
    } finally {
      process.env.NODE_ENV = original;
      delete process.env.SEED_ALLOW_PRODUCTION;
    }
  });
});

describe("Meridian Health System seed — headline facts", () => {
  it("Billing Engine DB: 5/5/5/5 -> 100.00 EXTREME, 87,100 unencrypted records", async () => {
    const asset = await prisma.asset.findFirst({
      where: { name: "Billing Engine DB" },
      include: { risks: true },
    });
    expect(asset).toMatchObject({ phiVolume: 87_100, encrypted: false });
    expect(asset!.risks[0]).toMatchObject({ likelihood: 5, impact: 5, exposure: 5, controlGap: 5, score: 100, band: "EXTREME" });
  });

  it("Northwind Claims Processing: BAA MISSING, 100.00 EXTREME, 71,300 PHI records, reaches Billing + Insurance", async () => {
    const vendor = await prisma.vendor.findFirst({
      where: { name: "Northwind Claims Processing" },
      include: { risks: true, assetAccess: { include: { asset: true } } },
    });
    expect(vendor).toMatchObject({ baaStatus: "MISSING", phiVolume: 71_300 });
    expect(vendor!.risks[0]).toMatchObject({ score: 100, band: "EXTREME" });
    const assetNames = vendor!.assetAccess.map((a) => a.asset.name).sort();
    expect(assetNames).toEqual(["Billing Engine DB", "Insurance Claims Gateway"]);
  });

  it("Robert Chen: inactive contractor holding an ADMIN grant on Imaging Archive, 243 days unused", async () => {
    const identity = await prisma.identity.findFirst({
      where: { displayName: { contains: "Robert Chen" } },
      include: { grants: { include: { asset: true } } },
    });
    expect(identity?.active).toBe(false);
    const grant = identity!.grants.find((g) => g.asset.name === "Imaging Archive (S3)");
    expect(grant).toMatchObject({ level: "ADMIN" });
    const daysSinceUse = Math.round((Date.now() - grant!.lastUsedAt!.getTime()) / 86_400_000);
    expect(daysSinceUse).toBe(243);
  });

  it("the Billing -> Insurance flow is unencrypted", async () => {
    const flow = await prisma.dataFlow.findFirst({
      where: { sourceAsset: { name: "Billing Engine DB" }, targetAsset: { name: "Insurance Claims Gateway" } },
    });
    expect(flow?.encrypted).toBe(false);
    expect(flow?.recordsPerDay).toBe(71_300);
  });

  it("carries the Tor-exit-node threat on Insurance Claims Gateway", async () => {
    const threat = await prisma.threat.findFirst({
      where: { title: "Authenticated session from Tor exit node" },
      include: { asset: true },
    });
    expect(threat).toMatchObject({ severity: "CRITICAL", status: "OPEN" });
    expect(threat?.asset.name).toBe("Insurance Claims Gateway");
  });

  it("has exactly 5 threats, 6 remediations including one ACCEPTED, 8 controls, and 4 policies", async () => {
    const [threats, remediations, accepted, controls, policies] = await Promise.all([
      prisma.threat.count(),
      prisma.remediation.count(),
      prisma.remediation.count({ where: { status: "ACCEPTED" } }),
      prisma.control.count(),
      prisma.policy.count(),
    ]);
    expect(threats).toBe(5);
    expect(remediations).toBe(6);
    expect(accepted).toBe(1);
    expect(controls).toBe(8);
    expect(policies).toBe(4);
  });

  it("Encrypted Backup and Recovery control is NOT_IMPLEMENTED / NOT_ASSESSED", async () => {
    const control = await prisma.control.findFirst({ where: { name: "Encrypted Backup and Recovery" } });
    expect(control).toMatchObject({ status: "NOT_IMPLEMENTED", effectiveness: "NOT_ASSESSED" });
  });

  it("Third-Party Risk Management Policy is UNDER_REVIEW with an overdue review date", async () => {
    const policy = await prisma.policy.findFirst({ where: { name: "Third-Party Risk Management Policy" } });
    expect(policy?.status).toBe("UNDER_REVIEW");
    expect(policy?.reviewDueAt).not.toBeNull();
    expect(policy!.reviewDueAt!.getTime()).toBeLessThan(Date.now());
  });
});
