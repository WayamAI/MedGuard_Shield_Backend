import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

const app = createApp();

let ids: Fixture;
let adminToken: string;
let viewerToken: string;

beforeEach(async () => {
  ids = await seedFixture();
  adminToken = await tokenFor(request(app), "admin@test.local");
  viewerToken = await tokenFor(request(app), "viewer@test.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const as = (token: string) => (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

describe("GET /api/phi-inventory", () => {
  it("reports category, sensitivity, holding systems, and volumes — metadata only, never patient rows", async () => {
    const res = await as(adminToken)("/api/phi-inventory");

    expect(res.status).toBe(200);
    const clinical = res.body.data.find((c: { name: string }) => c.name === "Clinical");
    expect(clinical).toMatchObject({
      sensitivity: "HIGH",
      recordsHeld: 1000,
      flowCount: 1,
      recordsPerDayInTransit: 250,
      unencryptedFlows: 1,
    });
    expect(clinical.systems).toEqual([{ assetId: expect.any(Number), assetName: "Test EHR", assetType: "EHR" }]);
  });

  it("is readable by every role", async () => {
    expect((await as(viewerToken)("/api/phi-inventory")).status).toBe(200);
  });

  it("requires authentication", async () => {
    expect((await request(app).get("/api/phi-inventory")).status).toBe(401);
  });
});

describe("PHI types CRUD", () => {
  it("lists and creates, admin only", async () => {
    const asViewer = await request(app)
      .post("/api/phi-types")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "Behavioral", sensitivity: "CRITICAL" });
    expect(asViewer.status).toBe(403);

    const created = await request(app)
      .post("/api/phi-types")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Behavioral", sensitivity: "CRITICAL" });
    expect(created.status).toBe(201);

    const list = await as(adminToken)("/api/phi-types");
    expect(list.body.data.map((t: { name: string }) => t.name)).toContain("Behavioral");
  });

  it("audits creation and update", async () => {
    const created = await request(app)
      .post("/api/phi-types")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Genetic", sensitivity: "CRITICAL" });

    await request(app)
      .patch(`/api/phi-types/${created.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sensitivity: "HIGH" });

    const events = await prisma.auditEvent.findMany({
      where: { organizationId: ids.organizationId, entityType: "PHIType" },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual(["PHI_TYPE_CREATED", "PHI_TYPE_UPDATED"]);
  });
});
