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

async function createKey(): Promise<string> {
  const res = await request(app)
    .post("/api/api-keys")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "test-connector" });
  return res.body.data.secret as string;
}

describe("API keys", () => {
  it("is admin-only to create, and shows the secret exactly once", async () => {
    const viewer = await request(app)
      .post("/api/api-keys")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "x" });
    expect(viewer.status).toBe(403);

    const res = await request(app).post("/api/api-keys").set("Authorization", `Bearer ${adminToken}`).send({ name: "x" });
    expect(res.status).toBe(201);
    expect(typeof res.body.data.secret).toBe("string");

    const list = await request(app).get("/api/api-keys").set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.data[0]).not.toHaveProperty("secret");
    expect(list.body.data[0]).not.toHaveProperty("keyHash");
  });
});

describe("POST /api/ingest/:recordType", () => {
  it("rejects a request with no API key", async () => {
    const res = await request(app).post("/api/ingest/assets").send({ rows: [{}] });
    expect(res.status).toBe(401);
  });

  it("dry-run validates without writing anything", async () => {
    const secret = await createKey();
    const before = await prisma.asset.count({ where: { organizationId: ids.organizationId } });

    const res = await request(app)
      .post("/api/ingest/assets")
      .set("X-API-Key", secret)
      .send({ dryRun: true, rows: [{ name: "Ingest Asset", type: "DATABASE", phiVolume: "10", encrypted: "true", mfaEnabled: "true" }] });

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    const after = await prisma.asset.count({ where: { organizationId: ids.organizationId } });
    expect(after).toBe(before);
  });

  it("commits and is auditable with the key as actor", async () => {
    const secret = await createKey();
    const res = await request(app)
      .post("/api/ingest/assets")
      .set("X-API-Key", secret)
      .send({ rows: [{ name: "Ingest Asset", type: "DATABASE", phiVolume: "10", encrypted: "true", mfaEnabled: "true" }] });

    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(1);

    const created = await prisma.asset.findFirst({ where: { organizationId: ids.organizationId, name: "Ingest Asset" } });
    expect(created).not.toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { organizationId: ids.organizationId, action: "IMPORT_COMPLETED" },
    });
    expect(audit?.metadata).toMatchObject({ via: "ingest-api", connectorLabel: "test-connector" });
  });

  it("rejects invalid rows without importing anything", async () => {
    const secret = await createKey();
    const res = await request(app)
      .post("/api/ingest/assets")
      .set("X-API-Key", secret)
      .send({ rows: [{ name: "", type: "NOT_A_TYPE" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMPORT_VALIDATION_FAILED");
  });

  it("a revoked key can no longer ingest", async () => {
    const createRes = await request(app).post("/api/api-keys").set("Authorization", `Bearer ${adminToken}`).send({ name: "revoke-me" });
    const secret = createRes.body.data.secret as string;
    await request(app).post(`/api/api-keys/${createRes.body.data.id}/revoke`).set("Authorization", `Bearer ${adminToken}`);

    const res = await request(app).post("/api/ingest/assets").set("X-API-Key", secret).send({ rows: [{}] });
    expect(res.status).toBe(401);
  });
});
