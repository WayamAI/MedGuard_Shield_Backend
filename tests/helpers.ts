import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/services/authService.js";
import { computeRisk } from "../src/services/riskScoring.js";

export const TEST_PASSWORD = "test-password";

/**
 * A deliberately small fixture — two assets, one PHI type, one flow, two
 * risks — chosen so every assertion can name exact numbers rather than
 * asserting "greater than zero", which passes even when seeding is broken.
 *
 * The two assets differ in mfaEnabled so the flow-status rules are
 * observable through the API.
 */
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Risk", "DataFlow", "AssetPHI", "Asset", "PHIType", "User" RESTART IDENTITY CASCADE',
  );
}

export async function seedFixture() {
  await resetDatabase();

  const passwordHash = await hashPassword(TEST_PASSWORD);
  await prisma.user.createMany({
    data: [
      { email: "admin@test.local", role: "ADMIN", passwordHash },
      { email: "analyst@test.local", role: "ANALYST", passwordHash },
      { email: "viewer@test.local", role: "VIEWER", passwordHash },
    ],
  });

  const ehr = await prisma.asset.create({
    data: { name: "Test EHR", type: "EHR", phiVolume: 1000, encrypted: true, mfaEnabled: true },
  });
  const billing = await prisma.asset.create({
    data: { name: "Test Billing", type: "DATABASE", phiVolume: 500, encrypted: false, mfaEnabled: false },
  });

  const clinical = await prisma.pHIType.create({
    data: { name: "Clinical", sensitivity: "HIGH" },
  });

  await prisma.assetPHI.create({
    data: { assetId: ehr.id, phiTypeId: clinical.id, recordsPerDay: 900 },
  });

  await prisma.dataFlow.create({
    data: {
      sourceAssetId: ehr.id,
      targetAssetId: billing.id,
      phiTypeId: clinical.id,
      recordsPerDay: 250,
      encrypted: false,
    },
  });

  for (const [assetId, l, i, e, c] of [
    [ehr.id, 3, 3, 3, 2],
    [billing.id, 5, 5, 5, 5],
  ] as const) {
    const { score, band } = computeRisk(l, i, e, c);
    await prisma.risk.create({
      data: { assetId, likelihood: l, impact: i, exposure: e, controlGap: c, score, band },
    });
  }

  return { ehrId: ehr.id, billingId: billing.id, phiTypeId: clinical.id };
}

/** Logs in through the real route and returns the bearer token. */
export async function tokenFor(
  agent: { post: (p: string) => any },
  email: string,
): Promise<string> {
  const res = await agent
    .post("/api/auth/login")
    .send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.token as string;
}
