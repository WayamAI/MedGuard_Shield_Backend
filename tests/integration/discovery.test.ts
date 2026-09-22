import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../src/lib/pagination.js";

/** Pagination, filtering, sorting and global search. */

const app = createApp();

let ids: Fixture;
let token: string;

beforeEach(async () => {
  ids = await seedFixture();
  token = await tokenFor(request(app), "admin@test.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const get = (path: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

/** 30 extra assets, enough to exceed the default page size of 25. */
async function seedManyAssets() {
  await prisma.asset.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      organizationId: ids.organizationId,
      name: `Bulk Asset ${String(i).padStart(2, "0")}`,
      type: "API" as const,
      phiVolume: i * 100,
    })),
  });
}

describe("pagination", () => {
  it("defaults to page 1 with the default page size", async () => {
    await seedManyAssets();
    const res = await get("/api/assets");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(res.body.meta).toMatchObject({
      page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 32, totalPages: 2,
    });
  });

  it("returns the second page", async () => {
    await seedManyAssets();
    const res = await get("/api/assets?page=2");

    expect(res.body.data).toHaveLength(7);
    expect(res.body.meta.page).toBe(2);
  });

  it("does not repeat a row between pages", async () => {
    await seedManyAssets();
    const first = (await get("/api/assets?page=1&pageSize=10")).body.data;
    const second = (await get("/api/assets?page=2&pageSize=10")).body.data;

    const ids1 = first.map((a: { id: number }) => a.id);
    const ids2 = second.map((a: { id: number }) => a.id);
    expect(ids1.filter((id: number) => ids2.includes(id))).toHaveLength(0);
  });

  /**
   * Capped rather than rejected: a client asking for 10,000 rows gets the
   * maximum, which is friendlier than a 400 and still bounds the query.
   */
  it("caps an oversized page size instead of refusing it", async () => {
    const res = await get("/api/assets?pageSize=100000");
    expect(res.status).toBe(200);
    expect(res.body.meta.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("rejects a page below 1", async () => {
    expect((await get("/api/assets?page=0")).status).toBe(400);
  });

  it("reports totalPages as 1 for an empty result", async () => {
    const res = await get("/api/assets?search=nothing-matches-this");
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta).toMatchObject({ total: 0, totalPages: 1 });
  });

  it("paginates every scalable list endpoint", async () => {
    for (const path of [
      "/api/assets", "/api/vendors", "/api/risks", "/api/dataflows",
      "/api/access", "/api/threats", "/api/identities", "/api/controls",
      "/api/policies", "/api/remediations",
    ]) {
      const res = await get(path);
      expect(res.status, `${path} should be 200`).toBe(200);
      expect(res.body.meta, `${path} should carry meta`).toMatchObject({
        page: 1, pageSize: DEFAULT_PAGE_SIZE,
      });
      expect(Array.isArray(res.body.data), `${path} data should be an array`).toBe(true);
    }
  });
});

describe("filtering and sorting", () => {
  it("filters assets by type", async () => {
    const res = await get("/api/assets?type=EHR");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Test EHR");
  });

  it("searches assets by name, case-insensitively", async () => {
    const res = await get("/api/assets?search=billing");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Test Billing");
  });

  it("sorts by phiVolume descending", async () => {
    const res = await get("/api/assets?sort=phiVolume&order=desc");
    expect(res.body.data.map((a: { phiVolume: number }) => a.phiVolume)).toEqual([1000, 500]);
  });

  /**
   * "No score" is not a low score. Sorting unassessed assets to the top of an
   * ascending list would read as though they were the safest things in the
   * estate.
   */
  it("sorts unassessed assets last regardless of direction", async () => {
    await prisma.asset.create({
      data: { organizationId: ids.organizationId, name: "No Risk Yet", type: "API" },
    });

    for (const order of ["asc", "desc"]) {
      const res = await get(`/api/assets?sort=riskScore&order=${order}`);
      const last = res.body.data[res.body.data.length - 1];
      expect(last.name, `order=${order}`).toBe("No Risk Yet");
    }
  });

  it("filters threats to the open ones", async () => {
    await prisma.threat.createMany({
      data: [
        { organizationId: ids.organizationId, assetId: ids.ehrId, severity: "LOW", status: "OPEN", title: "Open one", description: "d" },
        { organizationId: ids.organizationId, assetId: ids.ehrId, severity: "LOW", status: "RESOLVED", title: "Closed one", description: "d" },
      ],
    });

    const res = await get("/api/threats?openOnly=true");
    expect(res.body.data.map((t: { title: string }) => t.title)).toEqual(["Open one"]);
  });

  it("filters access to flagged grants only, with a truthful total", async () => {
    const [clean, bad] = await Promise.all([
      prisma.identity.create({
        data: { organizationId: ids.organizationId, displayName: "Clean", kind: "USER", mfaEnabled: true },
      }),
      prisma.identity.create({
        data: { organizationId: ids.organizationId, displayName: "Bad", kind: "USER", mfaEnabled: false },
      }),
    ]);
    await prisma.accessGrant.createMany({
      data: [
        { organizationId: ids.organizationId, identityId: clean.id, assetId: ids.ehrId, lastUsedAt: new Date() },
        { organizationId: ids.organizationId, identityId: bad.id, assetId: ids.ehrId, lastUsedAt: new Date() },
      ],
    });

    const res = await get("/api/access?flaggedOnly=true");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].identityName).toBe("Bad");
    expect(res.body.meta.total).toBe(1);
  });

  it("filters data flows by derived status", async () => {
    const res = await get("/api/dataflows?status=violation");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("violation");
    expect(res.body.meta.total).toBe(1);
  });
});

describe("global search", () => {
  it("finds an asset by name", async () => {
    const res = await get("/api/search?q=Test EHR");
    expect(res.status).toBe(200);

    const hit = res.body.data.results.find((r: { type: string }) => r.type === "asset");
    expect(hit).toMatchObject({ type: "asset", title: "Test EHR" });
    expect(hit.context).toBeTypeOf("string");
  });

  it("searches across several entity types at once", async () => {
    await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Findable Vendor" },
    });
    await prisma.control.create({
      data: {
        organizationId: ids.organizationId, name: "Findable Control",
        description: "d", category: "ACCESS",
      },
    });

    const res = await get("/api/search?q=Findable");
    const types = res.body.data.results.map((r: { type: string }) => r.type);
    expect(types).toContain("vendor");
    expect(types).toContain("control");
  });

  it("restricts to the requested types", async () => {
    await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Test Vendor Co" },
    });

    const res = await get("/api/search?q=Test&types=vendor");
    const types = new Set(res.body.data.results.map((r: { type: string }) => r.type));
    expect([...types]).toEqual(["vendor"]);
  });

  /**
   * Bounded by construction. An unbounded cross-table scan is a
   * denial-of-service primitive handed to any authenticated user.
   */
  it("refuses a query shorter than the minimum", async () => {
    expect((await get("/api/search?q=a")).status).toBe(400);
  });

  it("requires a query at all", async () => {
    expect((await get("/api/search")).status).toBe(400);
  });

  it("honours an explicit limit", async () => {
    await prisma.asset.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        organizationId: ids.organizationId,
        name: `Searchable ${i}`,
        type: "API" as const,
      })),
    });

    const res = await get("/api/search?q=Searchable&limit=3");
    expect(res.body.data.results).toHaveLength(3);
    expect(res.body.data.truncated).toBe(true);
  });

  it("excludes archived records", async () => {
    await prisma.asset.update({
      where: { id: ids.billingId },
      data: { archivedAt: new Date() },
    });

    const res = await get("/api/search?q=Test Billing");
    expect(res.body.data.results).toHaveLength(0);
  });

  it("requires authentication", async () => {
    expect((await request(app).get("/api/search?q=Test")).status).toBe(401);
  });
});

describe("reports", () => {
  it("counts the estate from persisted rows", async () => {
    const res = await get("/api/reports/risk-assessment");

    expect(res.status).toBe(200);
    expect(res.body.data.assets).toMatchObject({ total: 2, assessed: 2, unassessed: 0 });
    expect(res.body.data.phi.totalRecords).toBe(1500);
    expect(res.body.data.riskDistribution.LOW).toBe(1);
    expect(res.body.data.riskDistribution.EXTREME).toBe(1);
    expect(res.body.data.flows).toMatchObject({ total: 1, unencrypted: 1 });
  });

  it("reports coverage rather than a compliance score, and says so", async () => {
    const res = await get("/api/reports/risk-assessment");

    expect(res.body.data.assets.assessmentCoverage).toBe(100);
    expect(res.body.data).not.toHaveProperty("complianceScore");
    expect(res.body.data.disclaimer).toContain("not a compliance score");
  });

  it("reflects a newly added unassessed asset in the coverage figure", async () => {
    await prisma.asset.create({
      data: { organizationId: ids.organizationId, name: "Third", type: "API" },
    });

    const res = await get("/api/reports/risk-assessment");
    expect(res.body.data.assets).toMatchObject({ total: 3, assessed: 2, unassessed: 1 });
    expect(res.body.data.assets.assessmentCoverage).toBe(66.7);
  });
});
