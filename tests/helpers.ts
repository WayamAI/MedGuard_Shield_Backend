import type request from "supertest";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/services/authService.js";
import { computeRisk } from "../src/services/riskScoring.js";

export const TEST_PASSWORD = "test-password";

/**
 * bcrypt is intentionally slow -- that is its job -- but hashing the same
 * constant on every beforeEach cost ~62ms a time and contributed to hook
 * timeouts. Hash once per process instead.
 */
let passwordHashPromise: Promise<string> | null = null;
function testPasswordHash(): Promise<string> {
  passwordHashPromise ??= hashPassword(TEST_PASSWORD);
  return passwordHashPromise;
}

/**
 * Logging in three roles per test cost ~240ms, most of it bcrypt.compare.
 * Tokens are safe to reuse across resets: requireAuth verifies the JWT
 * signature and claims without touching the database, and the fixture
 * recreates users in a fixed order after RESTART IDENTITY, so the ids the
 * token carries still name the same people.
 *
 * Keyed by email. Cleared by resetTokenCache() if a test ever needs a
 * genuinely fresh login.
 */
const tokenCache = new Map<string, string>();

export function resetTokenCache(): void {
  tokenCache.clear();
}

/**
 * A deliberately small fixture — two assets, one PHI type, one flow, two
 * risks — chosen so every assertion can name exact numbers rather than
 * asserting "greater than zero", which passes even when seeding is broken.
 *
 * The two assets differ in mfaEnabled so the flow-status rules are
 * observable through the API.
 */
/**
 * Truncates every application table, discovered from the database rather than
 * listed here. A hardcoded list silently goes stale the moment a model is
 * added -- which it did: the vendor tables were missing, so rows leaked
 * between tests and every unique constraint tripped on the second run.
 */
export async function resetDatabase() {
  const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'`,
  );
  if (rows.length === 0) return;

  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function seedFixture() {
  await resetDatabase();

  const passwordHash = await testPasswordHash();
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

/** Whatever `request(app)` hands back -- taken from supertest rather than
 * approximated, since a hand-rolled shape drifts from the real one. */
type LoginAgent = ReturnType<typeof request>;

/** Logs in through the real route and returns the bearer token. */
export async function tokenFor(agent: LoginAgent, email: string): Promise<string> {
  const cached = tokenCache.get(email);
  if (cached) return cached;

  const res = await agent.post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const token: unknown = res.body?.data?.token;
  if (typeof token !== "string") {
    throw new Error(`login for ${email} returned no token: ${JSON.stringify(res.body)}`);
  }
  tokenCache.set(email, token);
  return token;
}
