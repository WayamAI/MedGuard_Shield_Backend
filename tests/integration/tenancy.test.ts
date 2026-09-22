import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

/**
 * Tenant isolation.
 *
 * These are the tests that would have to fail before any of the others
 * mattered: a PHI platform that leaks across customers is worse than one with
 * no features at all.
 *
 * The fixture seeds a second organisation ("Rival Health") holding its own
 * asset, vendor, identity and threat, and a user who belongs only to it. Every
 * assertion below is therefore against *real rows that exist*, not against an
 * empty database — a scope that is silently missing returns Rival's data and
 * the test fails, which a fixture with one tenant could never detect.
 */

const app = createApp();

let ids: Fixture;
let token: string;
let outsiderToken: string;

beforeEach(async () => {
  ids = await seedFixture();
  token = await tokenFor(request(app), "admin@test.local");
  outsiderToken = await tokenFor(request(app), "outsider@rival.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const asUs = (path: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);
const asThem = (path: string) =>
  request(app).get(path).set("Authorization", `Bearer ${outsiderToken}`);

describe("the session names the organization, not the request", () => {
  it("issues a token carrying the caller's organization", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: "test-password" });

    expect(res.status).toBe(200);
    expect(res.body.data.user.organizationId).toBe(ids.organizationId);
  });

  it("signs the outsider into their own organization, not ours", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "outsider@rival.local", password: "test-password" });

    expect(res.body.data.user.organizationId).toBe(ids.otherOrganizationId);
    expect(res.body.data.user.organizationId).not.toBe(ids.organizationId);
  });

  it("refuses an account with no membership rather than signing it in unscoped", async () => {
    await prisma.user.create({
      data: {
        email: "orphan@test.local",
        role: "ADMIN",
        // Same bcrypt hash as the fixture users, via the same password.
        passwordHash: (await prisma.user.findUniqueOrThrow({
          where: { email: "admin@test.local" },
          select: { passwordHash: true },
        })).passwordHash,
      },
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "orphan@test.local", password: "test-password" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

describe("list endpoints return only the caller's organization", () => {
  it("does not include the other tenant's asset", async () => {
    const res = await asUs("/api/assets");
    expect(res.status).toBe(200);

    const names = res.body.data.map((a: { name: string }) => a.name);
    expect(names).toContain("Test EHR");
    expect(names).not.toContain("Rival EHR");
    expect(res.body.meta.total).toBe(2);
  });

  it("does not include the other tenant's vendor", async () => {
    const names = (await asUs("/api/vendors")).body.data.map((v: { name: string }) => v.name);
    expect(names).not.toContain("Rival Vendor");
  });

  it("does not include the other tenant's identity", async () => {
    const names = (await asUs("/api/identities")).body.data.map(
      (i: { displayName: string }) => i.displayName,
    );
    expect(names).not.toContain("Rival Person");
  });

  it("does not include the other tenant's threat", async () => {
    const titles = (await asUs("/api/threats")).body.data.map((t: { title: string }) => t.title);
    expect(titles).not.toContain("Rival threat");
  });

  it("shows each tenant a different estate from the same endpoint", async () => {
    const ours = (await asUs("/api/assets")).body.data.map((a: { name: string }) => a.name);
    const theirs = (await asThem("/api/assets")).body.data.map((a: { name: string }) => a.name);

    expect(ours).toEqual(["Test Billing", "Test EHR"]);
    expect(theirs).toEqual(["Rival EHR"]);
  });
});

describe("detail endpoints 404 across the boundary rather than leaking", () => {
  /**
   * 404 and not 403 on purpose. Telling a caller "that exists but is not
   * yours" confirms the id is real in another tenant, which is itself a small
   * leak — from outside, a record in another organisation is indistinguishable
   * from one that does not exist.
   */
  it("404s another tenant's asset", async () => {
    const res = await asUs(`/api/assets/${ids.rivalAssetId}`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).not.toContain("Rival");
  });

  it("404s another tenant's vendor", async () => {
    expect((await asUs(`/api/vendors/${ids.rivalVendorId}`)).status).toBe(404);
  });

  it("404s another tenant's identity", async () => {
    expect((await asUs(`/api/identities/${ids.rivalIdentityId}`)).status).toBe(404);
  });

  it("404s another tenant's threat", async () => {
    expect((await asUs(`/api/threats/${ids.rivalThreatId}`)).status).toBe(404);
  });
});

describe("writes cannot cross the boundary either", () => {
  it("refuses to archive another tenant's asset", async () => {
    const res = await request(app)
      .post(`/api/assets/${ids.rivalAssetId}/archive`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);

    const rival = await prisma.asset.findUnique({ where: { id: ids.rivalAssetId } });
    expect(rival?.archivedAt).toBeNull();
  });

  it("refuses to assess another tenant's asset", async () => {
    const res = await request(app)
      .post(`/api/assets/${ids.rivalAssetId}/assessment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ likelihood: 5, impact: 5, exposure: 5, controlGap: 5 });

    expect(res.status).toBe(404);
    expect(await prisma.risk.findUnique({ where: { assetId: ids.rivalAssetId } })).toBeNull();
  });

  it("refuses to patch another tenant's vendor", async () => {
    const res = await request(app)
      .patch(`/api/vendors/${ids.rivalVendorId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ baaStatus: "SIGNED" });

    expect(res.status).toBe(404);

    const rival = await prisma.vendor.findUnique({ where: { id: ids.rivalVendorId } });
    expect(rival?.baaStatus).toBe("MISSING");
  });

  /**
   * The subtle one: a write path that stores a foreign key without checking it
   * would let a caller attach their own record to another tenant's row and
   * then read that row's name back out of their own detail response. A
   * cross-tenant read through a write.
   */
  it("refuses to link a remediation to another tenant's asset", async () => {
    const res = await request(app)
      .post("/api/remediations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Attempted cross-tenant link",
        description: "d",
        recommendation: "r",
        assetId: ids.rivalAssetId,
      });

    expect(res.status).toBe(404);
    expect(await prisma.remediation.count()).toBe(0);
  });

  it("refuses to grant one tenant's identity access to another tenant's asset", async () => {
    const identity = await prisma.identity.create({
      data: { organizationId: ids.organizationId, displayName: "Our Person", kind: "USER" },
    });

    const res = await request(app)
      .post("/api/access")
      .set("Authorization", `Bearer ${token}`)
      .send({ identityId: identity.id, assetId: ids.rivalAssetId });

    expect(res.status).toBe(404);
    expect(await prisma.accessGrant.count()).toBe(0);
  });

  it("stamps a created asset with the caller's organization, not one they name", async () => {
    // organizationId is not in the schema for this body, so it is stripped by
    // Zod rather than honoured. Sending it must not change where the row lands.
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Injected", type: "API", organizationId: ids.otherOrganizationId });

    expect(res.status).toBe(201);

    const created = await prisma.asset.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(created.organizationId).toBe(ids.organizationId);
  });
});

describe("aggregates and search respect the boundary", () => {
  it("counts only our assets in the risk report", async () => {
    const res = await asUs("/api/reports/risk-assessment");
    expect(res.status).toBe(200);
    expect(res.body.data.assets.total).toBe(2);
    expect(res.body.data.organization.id).toBe(ids.organizationId);
  });

  it("does not surface another tenant's records in global search", async () => {
    const res = await asUs("/api/search?q=Rival");
    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(0);
  });

  it("finds our own records with the same query shape", async () => {
    const res = await asUs("/api/search?q=Test EHR");
    expect(res.body.data.results.some((r: { title: string }) => r.title === "Test EHR")).toBe(true);
  });

  it("scopes the audit trail to the caller's organization", async () => {
    // Generate one event in each tenant.
    await request(app).post("/api/assets").set("Authorization", `Bearer ${token}`)
      .send({ name: "Ours", type: "API" });
    await request(app).post("/api/assets").set("Authorization", `Bearer ${outsiderToken}`)
      .send({ name: "Theirs", type: "API" });

    const ours = await asUs("/api/audit?action=ASSET_CREATED");
    expect(ours.status).toBe(200);
    expect(ours.body.data).toHaveLength(1);
    expect(ours.body.data[0].metadata.name).toBe("Ours");
  });
});
