import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor } from "../helpers.js";
import { computeRisk } from "../../src/services/riskScoring.js";

const app = createApp();
let tokens: Record<"ADMIN" | "ANALYST" | "VIEWER", string>;
let ids: Awaited<ReturnType<typeof seedFixture>>;
let vendorId: number;

const DAY = 86_400_000;

beforeEach(async () => {
  ids = await seedFixture();
  tokens = {
    ADMIN: await tokenFor(request(app), "admin@test.local"),
    ANALYST: await tokenFor(request(app), "analyst@test.local"),
    VIEWER: await tokenFor(request(app), "viewer@test.local"),
  };

  const vendor = await prisma.vendor.create({
    data: {
      organizationId: ids.organizationId, name: "Test Vendor",
      baaStatus: "MISSING",
      phiVolume: 5000,
      lastAssessedAt: new Date(Date.now() - 400 * DAY),
    },
  });
  vendorId = vendor.id;
  await prisma.vendorAssetAccess.create({ data: { vendorId, assetId: ids.ehrId } });

  const { score, band } = computeRisk(5, 5, 5, 5);
  await prisma.vendorRisk.create({
    data: { organizationId: ids.organizationId, vendorId, likelihood: 5, impact: 5, exposure: 5, controlGap: 5, score, band },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const get = (path: string, role: keyof typeof tokens = "ADMIN") =>
  request(app).get(path).set("Authorization", `Bearer ${tokens[role]}`);

describe("GET /api/vendors", () => {
  it("requires authentication", async () => {
    expect((await request(app).get("/api/vendors")).status).toBe(401);
  });

  it("returns vendors with derived compliance flags", async () => {
    const res = await get("/api/vendors");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      name: "Test Vendor",
      baaStatus: "MISSING",
      baaCompliant: false,
      assessmentOverdue: true,
      assetCount: 1,
      assets: ["Test EHR"],
      risk: { score: 100, band: "EXTREME" },
    });
    expect(res.body.data[0].daysSinceAssessment).toBeGreaterThanOrEqual(399);
  });

  it("treats a never-assessed vendor as overdue, not unknown", async () => {
    await prisma.vendor.update({ where: { id: vendorId }, data: { lastAssessedAt: null } });
    const res = await get("/api/vendors");
    expect(res.body.data[0].daysSinceAssessment).toBeNull();
    expect(res.body.data[0].assessmentOverdue).toBe(true);
  });

  it("marks a recently assessed vendor with a signed BAA as compliant", async () => {
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { baaStatus: "SIGNED", lastAssessedAt: new Date(Date.now() - 10 * DAY) },
    });
    const res = await get("/api/vendors");
    expect(res.body.data[0]).toMatchObject({ baaCompliant: true, assessmentOverdue: false });
  });

  it("is readable by VIEWER", async () => {
    expect((await get("/api/vendors", "VIEWER")).status).toBe(200);
  });
});

describe("GET /api/vendors/:id", () => {
  it("returns the full risk breakdown and asset access list", async () => {
    const res = await get(`/api/vendors/${vendorId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.risk).toMatchObject({
      likelihood: 5, impact: 5, exposure: 5, controlGap: 5, score: 100, band: "EXTREME",
    });
    expect(res.body.data.assets[0]).toMatchObject({ name: "Test EHR", type: "EHR" });
  });

  it("404s an unknown id", async () => {
    expect((await get("/api/vendors/999999")).status).toBe(404);
  });

  it("400s a non-numeric id", async () => {
    expect((await get("/api/vendors/abc")).status).toBe(400);
  });
});

describe("vendor writes follow the same RBAC rules as assets", () => {
  const body = { name: "New Vendor", baaStatus: "PENDING" as const, phiVolume: 100 };

  it("allows ADMIN to create", async () => {
    const res = await request(app).post("/api/vendors")
      .set("Authorization", `Bearer ${tokens.ADMIN}`).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("New Vendor");
  });

  it("refuses ANALYST to create — vendor records are configuration", async () => {
    const res = await request(app).post("/api/vendors")
      .set("Authorization", `Bearer ${tokens.ANALYST}`).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("vendor:create");
  });

  it("refuses VIEWER with 403 and writes nothing", async () => {
    const res = await request(app).post("/api/vendors")
      .set("Authorization", `Bearer ${tokens.VIEWER}`).send(body);
    expect(res.status).toBe(403);
    expect(await prisma.vendor.findFirst({ where: { name: "New Vendor" } })).toBeNull();
  });

  it("allows ADMIN to patch and leaves untouched fields alone", async () => {
    const res = await request(app).patch(`/api/vendors/${vendorId}`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`).send({ baaStatus: "SIGNED" });
    expect(res.status).toBe(200);
    expect(res.body.data.baaStatus).toBe("SIGNED");
    expect(res.body.data.phiVolume).toBe(5000);
  });

  it("refuses VIEWER's patch and leaves the row unchanged", async () => {
    const res = await request(app).patch(`/api/vendors/${vendorId}`)
      .set("Authorization", `Bearer ${tokens.VIEWER}`).send({ baaStatus: "SIGNED" });
    expect(res.status).toBe(403);
    const row = await prisma.vendor.findUnique({ where: { id: vendorId } });
    expect(row?.baaStatus).toBe("MISSING");
  });

  it("409s a duplicate name", async () => {
    const res = await request(app).post("/api/vendors")
      .set("Authorization", `Bearer ${tokens.ADMIN}`).send({ name: "Test Vendor" });
    expect(res.status).toBe(409);
  });

  it("404s a PATCH against an unknown vendor id", async () => {
    const res = await request(app).patch("/api/vendors/999999")
      .set("Authorization", `Bearer ${tokens.ADMIN}`).send({ baaStatus: "SIGNED" });
    expect(res.status).toBe(404);
  });

  it("400s a PATCH with an empty body", async () => {
    const res = await request(app).patch(`/api/vendors/${vendorId}`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`).send({});
    expect(res.status).toBe(400);
  });

  it("400s an invalid baaStatus", async () => {
    const res = await request(app).post("/api/vendors")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ name: "Bad", baaStatus: "PROBABLY_FINE" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/vendors/:id/recompute", () => {
  it("reuses the shared risk engine and reports the previous score", async () => {
    await prisma.vendorRisk.updateMany({
      where: { vendorId },
      data: { likelihood: 3, impact: 3, exposure: 3, controlGap: 3 },
    });

    const res = await request(app).post(`/api/vendors/${vendorId}/recompute`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    expect(res.status).toBe(200);
    // Same formula as asset risk: 3*3*3*3 = 81 -> 12.96 LOW.
    expect(res.body.data).toMatchObject({
      vendorName: "Test Vendor",
      score: 12.96,
      band: "LOW",
      previous: { score: 100, band: "EXTREME" },
    });
  });

  it("persists the recomputed value", async () => {
    await prisma.vendorRisk.updateMany({
      where: { vendorId },
      data: { likelihood: 3, impact: 3, exposure: 3, controlGap: 3 },
    });
    await request(app).post(`/api/vendors/${vendorId}/recompute`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    const stored = await prisma.vendorRisk.findFirst({ where: { vendorId } });
    expect(stored?.score).toBe(12.96);
  });

  it("refuses VIEWER", async () => {
    const res = await request(app).post(`/api/vendors/${vendorId}/recompute`)
      .set("Authorization", `Bearer ${tokens.VIEWER}`);
    expect(res.status).toBe(403);
  });

  it("404s an unknown vendor id", async () => {
    const res = await request(app).post("/api/vendors/999999/recompute")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);
    expect(res.status).toBe(404);
  });

  it("400s a non-numeric vendor id", async () => {
    const res = await request(app).post("/api/vendors/abc/recompute")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);
    expect(res.status).toBe(400);
  });
});
