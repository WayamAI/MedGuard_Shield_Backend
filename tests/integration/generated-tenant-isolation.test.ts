import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

/**
 * Generated tenant-isolation coverage over every ID-taking route that has a
 * real entity type to test against (the ~9 entities the fixture creates a
 * "rival org" row for — see tests/helpers.ts). For each one: a GET/PATCH of
 * the rival's row, as a *real, authenticated* admin of the OTHER org, must
 * 404 — not 403 (which would leak that the row exists) and not 200.
 *
 * Also covers: list endpoints never return a rival row, search never returns
 * a rival row, and a create body's organizationId (if someone tried to smuggle
 * one in) is ignored in favour of the caller's own token-derived org.
 */

const app = createApp();
let ids: Fixture;
let admin: string;

// Extra rival-org rows this file needs that tests/helpers.ts's shared
// seedFixture() does not create — added here rather than to the shared
// fixture, since other suites assert exact global row counts (e.g.
// tenancy.test.ts expects `prisma.remediation.count()` to be exactly 0 at a
// point in its own test) and distinctly-named rows of their own (policies.test.ts
// creates its own "Rival Control"), both of which a shared addition broke.
let rivalControlId: number;
let rivalPolicyId: number;
let rivalRemediationId: number;
let rivalAccessGrantId: number;
let rivalPhiTypeId: number;

beforeAll(async () => {
  ids = await seedFixture();
  admin = await tokenFor(request(app), "admin@test.local");

  const control = await prisma.control.create({
    data: {
      organizationId: ids.otherOrganizationId, name: "Tenant-Isolation Rival Control", description: "x",
      category: "ACCESS", status: "IMPLEMENTED", effectiveness: "EFFECTIVE",
    },
  });
  rivalControlId = control.id;

  const policy = await prisma.policy.create({
    data: { organizationId: ids.otherOrganizationId, name: "Tenant-Isolation Rival Policy", description: "x" },
  });
  rivalPolicyId = policy.id;

  const remediation = await prisma.remediation.create({
    data: {
      organizationId: ids.otherOrganizationId, title: "Tenant-Isolation Rival Remediation",
      description: "x", recommendation: "x", assetId: ids.rivalAssetId,
    },
  });
  rivalRemediationId = remediation.id;

  const accessGrant = await prisma.accessGrant.create({
    data: { organizationId: ids.otherOrganizationId, identityId: ids.rivalIdentityId, assetId: ids.rivalAssetId, level: "READ" },
  });
  rivalAccessGrantId = accessGrant.id;

  const phiType = await prisma.pHIType.create({
    data: { organizationId: ids.otherOrganizationId, name: "Tenant-Isolation Rival PHI", sensitivity: "HIGH" },
  });
  rivalPhiTypeId = phiType.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = () => ({ Authorization: `Bearer ${admin}` });

type Case = { entity: string; path: string; rivalId: number; patchBody?: object };

function cases(): Case[] {
  return [
    { entity: "asset", path: "assets", rivalId: ids.rivalAssetId, patchBody: { name: "stolen" } },
    { entity: "vendor", path: "vendors", rivalId: ids.rivalVendorId, patchBody: { baaStatus: "SIGNED" } },
    { entity: "identity", path: "identities", rivalId: ids.rivalIdentityId, patchBody: { displayName: "stolen" } },
    { entity: "threat", path: "threats", rivalId: ids.rivalThreatId, patchBody: { description: "stolen" } },
    { entity: "control", path: "controls", rivalId: rivalControlId, patchBody: { owner: "stolen" } },
    { entity: "policy", path: "policies", rivalId: rivalPolicyId, patchBody: { status: "ACTIVE" } },
    { entity: "remediation", path: "remediations", rivalId: rivalRemediationId, patchBody: { description: "stolen" } },
    { entity: "access grant", path: "access", rivalId: rivalAccessGrantId, patchBody: { level: "WRITE" } },
    { entity: "phi type", path: "phi-types", rivalId: rivalPhiTypeId, patchBody: { sensitivity: "LOW" } },
  ];
}

describe("tenant isolation: GET and PATCH by id", () => {
  it("404s GET for every rival-org entity, by real id, as an admin of a different org", async () => {
    const failures: string[] = [];
    for (const c of cases()) {
      const res = await request(app).get(`/api/${c.path}/${c.rivalId}`).set(auth());
      if (res.status !== 404) failures.push(`GET /api/${c.path}/${c.rivalId} (${c.entity}) -> ${res.status}, expected 404`);
    }
    expect(failures).toEqual([]);
  });

  it("404s PATCH for every rival-org entity, by real id, as an admin of a different org", async () => {
    const failures: string[] = [];
    for (const c of cases()) {
      const res = await request(app).patch(`/api/${c.path}/${c.rivalId}`).set(auth()).send(c.patchBody);
      if (res.status !== 404) failures.push(`PATCH /api/${c.path}/${c.rivalId} (${c.entity}) -> ${res.status}, expected 404`);
    }
    expect(failures).toEqual([]);
  });
});

describe("tenant isolation: list and search never leak a rival row", () => {
  it("list endpoints never include the rival's row", async () => {
    const checks: Array<[string, string]> = [
      ["assets", "Rival EHR"],
      ["vendors", "Rival Vendor"],
      ["identities", "Rival Person"],
      ["threats", "Rival threat"],
      ["controls", "Tenant-Isolation Rival Control"],
      ["policies", "Tenant-Isolation Rival Policy"],
      ["remediations", "Tenant-Isolation Rival Remediation"],
    ];
    const failures: string[] = [];
    for (const [path, name] of checks) {
      const res = await request(app).get(`/api/${path}`).set(auth());
      const names = JSON.stringify(res.body).includes(name);
      if (names) failures.push(`GET /api/${path} includes "${name}"`);
    }
    expect(failures).toEqual([]);
  });

  it("search never returns a rival row", async () => {
    const res = await request(app).get("/api/search?q=Rival").set(auth());
    expect(res.body.data.results).toEqual([]);
  });
});

describe("tenant isolation: a body-supplied organizationId is ignored", () => {
  it("POST /api/assets ignores an injected organizationId and creates under the caller's real org", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set(auth())
      .send({ name: "Smuggled Org Asset", type: "OTHER", organizationId: ids.otherOrganizationId });
    expect(res.status).toBe(201);

    const row = await prisma.asset.findUnique({ where: { id: res.body.data.id } });
    expect(row?.organizationId).toBe(ids.organizationId);
    expect(row?.organizationId).not.toBe(ids.otherOrganizationId);
  });

  it("POST /api/vendors ignores an injected organizationId and creates under the caller's real org", async () => {
    const res = await request(app)
      .post("/api/vendors")
      .set(auth())
      .send({ name: "Smuggled Org Vendor", organizationId: ids.otherOrganizationId });
    expect(res.status).toBe(201);

    const row = await prisma.vendor.findUnique({ where: { id: res.body.data.id } });
    expect(row?.organizationId).toBe(ids.organizationId);
    expect(row?.organizationId).not.toBe(ids.otherOrganizationId);
  });
});
