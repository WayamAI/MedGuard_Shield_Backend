import "dotenv/config";
import type { AssetType, BaaStatus, Sensitivity } from "../src/generated/prisma/client.js";
import { prisma } from "../src/lib/prisma.js";
import { computeRisk } from "../src/services/riskScoring.js";
import { hashPassword } from "../src/services/authService.js";

/**
 * Demo dataset for Meridian Health — a small but realistic PHI estate.
 *
 * Names and daily record volumes mirror the flows the MedGuard frontend
 * already tells a story about (Patient Portal -> EHR -> Lab/Imaging/Billing ->
 * external recipients), so the Sankey reads the same whether it is fed by
 * these rows or by the old mocks.
 *
 * Risk inputs are chosen to spread across all five bands and across eight
 * distinct likelihood x impact cells, so the matrix does not clump.
 */

type AssetSeed = {
  key: string;
  name: string;
  type: AssetType;
  phiVolume: number;
  encrypted: boolean;
  mfaEnabled: boolean;
  daysSinceAssessment: number | null;
};

const ASSETS: AssetSeed[] = [
  { key: "portal",    name: "Patient Portal",          type: "OTHER",         phiVolume: 12_400,  encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 12 },
  { key: "pharmacy",  name: "Pharmacy System",         type: "OTHER",         phiVolume: 38_900,  encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 21 },
  { key: "ehr",       name: "Epic EHR Core",           type: "EHR",           phiVolume: 412_000, encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 4 },
  { key: "lab",       name: "Lab Results API",         type: "API",           phiVolume: 64_200,  encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 30 },
  { key: "imaging",   name: "Imaging Archive (S3)",    type: "CLOUD_STORAGE", phiVolume: 51_200,  encrypted: true,  mfaEnabled: false, daysSinceAssessment: 46 },
  { key: "billing",   name: "Billing Engine DB",       type: "DATABASE",      phiVolume: 87_100,  encrypted: false, mfaEnabled: false, daysSinceAssessment: 88 },
  { key: "analytics", name: "Clinical Analytics Lake", type: "ANALYTICS",     phiVolume: 229_000, encrypted: true,  mfaEnabled: false, daysSinceAssessment: 17 },
  { key: "insurance", name: "Insurance Claims Gateway", type: "API",          phiVolume: 71_300,  encrypted: false, mfaEnabled: false, daysSinceAssessment: null },
];

const PHI_TYPES: Array<{ key: string; name: string; sensitivity: Sensitivity }> = [
  { key: "clinical",    name: "Clinical",    sensitivity: "HIGH" },
  { key: "financial",   name: "Financial",   sensitivity: "MEDIUM" },
  { key: "genetic",     name: "Genetic",     sensitivity: "CRITICAL" },
  { key: "demographic", name: "Demographic", sensitivity: "LOW" },
];

/** Which PHI categories each asset holds, and at what daily volume. */
const ASSET_PHI: Array<{ asset: string; phiType: string; recordsPerDay: number }> = [
  { asset: "portal",    phiType: "demographic", recordsPerDay: 12_400 },
  { asset: "pharmacy",  phiType: "clinical",    recordsPerDay: 38_900 },
  { asset: "ehr",       phiType: "clinical",    recordsPerDay: 284_000 },
  { asset: "ehr",       phiType: "demographic", recordsPerDay: 112_000 },
  { asset: "ehr",       phiType: "genetic",     recordsPerDay: 16_000 },
  { asset: "lab",       phiType: "clinical",    recordsPerDay: 45_400 },
  { asset: "lab",       phiType: "genetic",     recordsPerDay: 18_800 },
  { asset: "imaging",   phiType: "clinical",    recordsPerDay: 51_200 },
  { asset: "billing",   phiType: "financial",   recordsPerDay: 87_100 },
  { asset: "analytics", phiType: "clinical",    recordsPerDay: 103_100 },
  { asset: "analytics", phiType: "genetic",     recordsPerDay: 18_800 },
  { asset: "analytics", phiType: "demographic", recordsPerDay: 6_400 },
  { asset: "insurance", phiType: "financial",   recordsPerDay: 71_300 },
];

/** The flow chain. Volumes vary ~14x end to end so ribbons read distinctly. */
const FLOWS: Array<{
  source: string; target: string; phiType: string; recordsPerDay: number; encrypted: boolean;
}> = [
  { source: "portal",    target: "ehr",       phiType: "demographic", recordsPerDay: 12_400, encrypted: true },
  { source: "pharmacy",  target: "ehr",       phiType: "clinical",    recordsPerDay: 38_900, encrypted: true },
  { source: "ehr",       target: "lab",       phiType: "clinical",    recordsPerDay: 64_200, encrypted: true },
  { source: "ehr",       target: "imaging",   phiType: "clinical",    recordsPerDay: 51_200, encrypted: true },
  { source: "ehr",       target: "billing",   phiType: "financial",   recordsPerDay: 87_100, encrypted: false },
  { source: "ehr",       target: "analytics", phiType: "clinical",    recordsPerDay: 29_500, encrypted: true },
  { source: "lab",       target: "analytics", phiType: "genetic",     recordsPerDay: 18_800, encrypted: true },
  { source: "imaging",   target: "analytics", phiType: "clinical",    recordsPerDay: 22_400, encrypted: true },
  { source: "billing",   target: "insurance", phiType: "financial",   recordsPerDay: 71_300, encrypted: false },
  { source: "analytics", target: "insurance", phiType: "demographic", recordsPerDay: 6_400,  encrypted: true },
];

/**
 * Assessor judgements, 1-5 each. score and band are never written by hand —
 * they come from computeRisk so the seed and the API agree by construction.
 */
const RISK_INPUTS: Array<{
  asset: string; likelihood: number; impact: number; exposure: number; controlGap: number;
}> = [
  { asset: "billing",   likelihood: 5, impact: 5, exposure: 5, controlGap: 5 }, // 100.00 EXTREME
  { asset: "insurance", likelihood: 4, impact: 5, exposure: 5, controlGap: 5 }, //  80.00 CRITICAL
  { asset: "ehr",       likelihood: 5, impact: 4, exposure: 5, controlGap: 3 }, //  48.00 HIGH
  { asset: "imaging",   likelihood: 4, impact: 4, exposure: 5, controlGap: 3 }, //  38.40 MODERATE
  { asset: "analytics", likelihood: 3, impact: 5, exposure: 4, controlGap: 3 }, //  28.80 MODERATE
  { asset: "lab",       likelihood: 3, impact: 4, exposure: 4, controlGap: 3 }, //  23.04 MODERATE
  { asset: "pharmacy",  likelihood: 2, impact: 4, exposure: 3, controlGap: 3 }, //  11.52 LOW
  { asset: "portal",    likelihood: 3, impact: 3, exposure: 3, controlGap: 2 }, //   8.64 LOW
];

/**
 * Demo accounts. All three share one password, taken from DEMO_USER_PASSWORD
 * so the credential is never committed. They exist to exercise the three
 * roles; there is no signup or invite flow yet.
 */
const USERS: Array<{ email: string; role: "ADMIN" | "ANALYST" | "VIEWER" }> = [
  { email: "admin@meridian.org", role: "ADMIN" },
  { email: "f.alrashid@meridian.org", role: "ANALYST" },
  { email: "a.patel@meridian.org", role: "VIEWER" },
];

/**
 * Vendors, spread deliberately across BAA and assessment states so the module
 * has something to show. The two worst cases are the point of the demo: a
 * vendor with PHI access and no BAA at all, and one whose BAA has expired.
 */
const VENDORS: Array<{
  key: string; name: string; baaStatus: BaaStatus; phiVolume: number;
  daysSinceAssessment: number | null; assets: string[];
  likelihood: number; impact: number; exposure: number; controlGap: number;
}> = [
  {
    key: "claims", name: "Northwind Claims Processing", baaStatus: "MISSING",
    phiVolume: 71_300, daysSinceAssessment: null, assets: ["billing", "insurance"],
    likelihood: 5, impact: 5, exposure: 5, controlGap: 5, // 100.00 EXTREME
  },
  {
    key: "transcribe", name: "Veritas Transcription", baaStatus: "EXPIRED",
    phiVolume: 44_800, daysSinceAssessment: 512, assets: ["ehr"],
    likelihood: 4, impact: 5, exposure: 5, controlGap: 5, // 80.00 CRITICAL
  },
  {
    key: "imaging", name: "Clarity Imaging Partners", baaStatus: "PENDING",
    phiVolume: 51_200, daysSinceAssessment: 240, assets: ["imaging", "lab"],
    likelihood: 4, impact: 4, exposure: 5, controlGap: 3, // 38.40 MODERATE
  },
  {
    key: "analytics", name: "Helix Population Analytics", baaStatus: "SIGNED",
    phiVolume: 229_000, daysSinceAssessment: 95, assets: ["analytics"],
    likelihood: 3, impact: 5, exposure: 4, controlGap: 3, // 28.80 MODERATE
  },
  {
    key: "backup", name: "Sentinel Backup Services", baaStatus: "SIGNED",
    phiVolume: 12_400, daysSinceAssessment: 30, assets: ["portal"],
    likelihood: 2, impact: 4, exposure: 3, controlGap: 3, // 11.52 LOW
  },
];

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function main() {
  // Idempotent, and RESTART IDENTITY keeps primary keys stable across
  // reseeds -- deleteMany() would leave the sequences advanced, so every
  // reseed would shift every id and break any link the frontend had saved.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "VendorRisk", "VendorAssetAccess", "Vendor", "Risk", "DataFlow", "AssetPHI", "Asset", "PHIType", "User" RESTART IDENTITY CASCADE',
  );

  const assetIds = new Map<string, number>();
  for (const a of ASSETS) {
    const created = await prisma.asset.create({
      data: {
        name: a.name,
        type: a.type,
        phiVolume: a.phiVolume,
        encrypted: a.encrypted,
        mfaEnabled: a.mfaEnabled,
        lastAssessedAt: a.daysSinceAssessment === null ? null : daysAgo(a.daysSinceAssessment),
      },
    });
    assetIds.set(a.key, created.id);
  }

  const phiTypeIds = new Map<string, number>();
  for (const p of PHI_TYPES) {
    const created = await prisma.pHIType.create({
      data: { name: p.name, sensitivity: p.sensitivity },
    });
    phiTypeIds.set(p.key, created.id);
  }

  const assetId = (key: string) => {
    const id = assetIds.get(key);
    if (id === undefined) throw new Error(`Unknown asset key in seed: ${key}`);
    return id;
  };
  const phiTypeId = (key: string) => {
    const id = phiTypeIds.get(key);
    if (id === undefined) throw new Error(`Unknown PHI type key in seed: ${key}`);
    return id;
  };

  await prisma.assetPHI.createMany({
    data: ASSET_PHI.map((link) => ({
      assetId: assetId(link.asset),
      phiTypeId: phiTypeId(link.phiType),
      recordsPerDay: link.recordsPerDay,
    })),
  });

  await prisma.dataFlow.createMany({
    data: FLOWS.map((f) => ({
      sourceAssetId: assetId(f.source),
      targetAssetId: assetId(f.target),
      phiTypeId: phiTypeId(f.phiType),
      recordsPerDay: f.recordsPerDay,
      encrypted: f.encrypted,
    })),
  });

  await prisma.risk.createMany({
    data: RISK_INPUTS.map((r) => {
      const { score, band } = computeRisk(r.likelihood, r.impact, r.exposure, r.controlGap);
      return {
        assetId: assetId(r.asset),
        likelihood: r.likelihood,
        impact: r.impact,
        exposure: r.exposure,
        controlGap: r.controlGap,
        score,
        band,
      };
    }),
  });

  const demoPassword = process.env.DEMO_USER_PASSWORD;
  if (!demoPassword) {
    throw new Error("DEMO_USER_PASSWORD is not set — see .env.example");
  }
  const passwordHash = await hashPassword(demoPassword);
  await prisma.user.createMany({
    data: USERS.map((u) => ({ ...u, passwordHash })),
  });

  for (const v of VENDORS) {
    const vendor = await prisma.vendor.create({
      data: {
        name: v.name,
        baaStatus: v.baaStatus,
        phiVolume: v.phiVolume,
        lastAssessedAt: v.daysSinceAssessment === null ? null : daysAgo(v.daysSinceAssessment),
      },
    });

    await prisma.vendorAssetAccess.createMany({
      data: v.assets.map((key) => ({ vendorId: vendor.id, assetId: assetId(key) })),
    });

    const { score, band } = computeRisk(v.likelihood, v.impact, v.exposure, v.controlGap);
    await prisma.vendorRisk.create({
      data: {
        vendorId: vendor.id,
        likelihood: v.likelihood, impact: v.impact,
        exposure: v.exposure, controlGap: v.controlGap,
        score, band,
      },
    });
  }

  const [assets, phiTypes, links, flows, risks, users, vendors, vendorAccess, vendorRisks] =
    await Promise.all([
      prisma.asset.count(),
      prisma.pHIType.count(),
      prisma.assetPHI.count(),
      prisma.dataFlow.count(),
      prisma.risk.count(),
      prisma.user.count(),
      prisma.vendor.count(),
      prisma.vendorAssetAccess.count(),
      prisma.vendorRisk.count(),
    ]);

  console.log(
    `[seed] assets=${assets} phiTypes=${phiTypes} assetPHI=${links} dataFlows=${flows} ` +
      `risks=${risks} users=${users} vendors=${vendors} vendorAccess=${vendorAccess} ` +
      `vendorRisks=${vendorRisks}`,
  );
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
