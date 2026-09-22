import type request from "supertest";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/services/authService.js";
import { computeRisk } from "../src/services/riskScoring.js";
import type { TenantContext } from "../src/lib/tenant.js";

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
 * Tokens are no longer cached across resets.
 *
 * They used to be, on the reasoning that requireAuth verifies a JWT without
 * touching the database. That is still true, but the token now carries an
 * `organizationId`, and the fixture creates two organisations whose ids move
 * with RESTART IDENTITY. A cached token would name the right user in the wrong
 * tenant -- which is exactly the bug the tenant-isolation tests exist to
 * catch, so caching here would hide it.
 */
export function resetTokenCache(): void {
  // Retained for API compatibility with existing tests; nothing to clear.
}

/**
 * Truncates every application table, discovered from the database rather than
 * listed here. A hardcoded list silently goes stale the moment a model is
 * added -- which it did once already, when the vendor tables were missing and
 * rows leaked between tests.
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

export type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/**
 * A deliberately small fixture -- two assets, one PHI type, one flow, two
 * risks -- chosen so every assertion can name exact numbers rather than
 * asserting "greater than zero", which passes even when seeding is broken.
 *
 * The two assets differ in mfaEnabled so the flow-status rules are observable
 * through the API.
 *
 * Nothing beyond that is seeded into the caller's own organisation: tests that
 * need a vendor, identity, grant, threat or control create their own, so the
 * exact-count assertions stay exact.
 *
 * **Two organisations are created.** The second ("Rival Health") holds its own
 * asset, vendor, identity and user, and exists solely so tenant isolation can
 * be tested against real rows rather than against absence. A query that
 * forgets its scope returns Rival's data and the test fails.
 */
export async function seedFixture() {
  await resetDatabase();

  const passwordHash = await testPasswordHash();

  const org = await prisma.organization.create({
    data: { name: "Test Health System", slug: "test-health" },
  });
  const otherOrg = await prisma.organization.create({
    data: { name: "Rival Health", slug: "rival-health" },
  });

  const users = await Promise.all(
    (
      [
        ["admin@test.local", "ADMIN"],
        ["analyst@test.local", "ANALYST"],
        ["viewer@test.local", "VIEWER"],
      ] as const
    ).map(([email, role]) =>
      prisma.user.create({
        data: {
          email,
          role,
          passwordHash,
          memberships: { create: { organizationId: org.id, role } },
        },
      }),
    ),
  );

  // Belongs to the other tenant only. Used to prove a valid session cannot
  // read across the boundary.
  const outsider = await prisma.user.create({
    data: {
      email: "outsider@rival.local",
      role: "ADMIN",
      passwordHash,
      memberships: { create: { organizationId: otherOrg.id, role: "ADMIN" } },
    },
  });

  const organizationId = org.id;

  const ehr = await prisma.asset.create({
    data: {
      organizationId, name: "Test EHR", type: "EHR",
      phiVolume: 1000, encrypted: true, mfaEnabled: true,
    },
  });
  const billing = await prisma.asset.create({
    data: {
      organizationId, name: "Test Billing", type: "DATABASE",
      phiVolume: 500, encrypted: false, mfaEnabled: false,
    },
  });

  const clinical = await prisma.pHIType.create({
    data: { organizationId, name: "Clinical", sensitivity: "HIGH" },
  });

  await prisma.assetPHI.create({
    data: { assetId: ehr.id, phiTypeId: clinical.id, recordsPerDay: 900 },
  });

  await prisma.dataFlow.create({
    data: {
      organizationId,
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
      data: {
        organizationId, assetId,
        likelihood: l, impact: i, exposure: e, controlGap: c,
        score, band,
      },
    });
  }

  // ------------------------------------------------- the other tenant's data
  const rivalAsset = await prisma.asset.create({
    data: {
      organizationId: otherOrg.id, name: "Rival EHR", type: "EHR",
      phiVolume: 9999, encrypted: true, mfaEnabled: true,
    },
  });
  const rivalVendor = await prisma.vendor.create({
    data: { organizationId: otherOrg.id, name: "Rival Vendor", baaStatus: "MISSING" },
  });
  const rivalIdentity = await prisma.identity.create({
    data: { organizationId: otherOrg.id, displayName: "Rival Person", kind: "USER" },
  });
  const rivalThreat = await prisma.threat.create({
    data: {
      organizationId: otherOrg.id, assetId: rivalAsset.id, severity: "CRITICAL",
      status: "OPEN", title: "Rival threat", description: "Belongs to the other tenant.",
    },
  });

  return {
    organizationId,
    otherOrganizationId: otherOrg.id,
    ehrId: ehr.id,
    billingId: billing.id,
    phiTypeId: clinical.id,
    adminUserId: users[0]!.id,
    outsiderUserId: outsider.id,
    rivalAssetId: rivalAsset.id,
    rivalVendorId: rivalVendor.id,
    rivalIdentityId: rivalIdentity.id,
    rivalThreatId: rivalThreat.id,
  };
}

/** A TenantContext for calling services directly, without HTTP. */
export function contextFor(
  fixture: Fixture,
  role: "ADMIN" | "ANALYST" | "VIEWER" = "ADMIN",
): TenantContext {
  return {
    userId: fixture.adminUserId,
    email: "admin@test.local",
    role,
    organizationId: fixture.organizationId,
  };
}

/** Whatever `request(app)` hands back -- taken from supertest rather than
 * approximated, since a hand-rolled shape drifts from the real one. */
type LoginAgent = ReturnType<typeof request>;

/** Logs in through the real route and returns the bearer access token. */
export async function tokenFor(agent: LoginAgent, email: string): Promise<string> {
  const res = await agent.post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const token: unknown = res.body?.data?.token;
  if (typeof token !== "string") {
    throw new Error(`login for ${email} returned no token: ${JSON.stringify(res.body)}`);
  }
  return token;
}

/** Logs in and returns the full session, for refresh-token tests. */
export async function sessionFor(agent: LoginAgent, email: string) {
  const res = await agent.post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as {
    token: string;
    refreshToken: string;
    expiresIn: number;
    user: { id: number; email: string; role: string; organizationId: number };
  };
}
