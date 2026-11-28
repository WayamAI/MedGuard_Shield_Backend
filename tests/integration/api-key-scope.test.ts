import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

const app = createApp();

let ids: Fixture;
let adminToken: string;
let apiKeySecret: string;

beforeEach(async () => {
  ids = await seedFixture();
  adminToken = await tokenFor(request(app), "admin@test.local");
  const created = await request(app)
    .post("/api/api-keys")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "scope-test-key" });
  apiKeySecret = created.body.data.secret;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("an API key is scoped to ingestion and nothing else", () => {
  it.each([
    ["get", "/api/assets"],
    ["get", "/api/audit"],
    ["get", "/api/audit/verify"],
    ["get", "/api/members"],
    ["post", "/api/auth/mfa/enroll"],
    ["get", "/api/notifications"],
    ["get", "/api/organization/settings"],
    ["get", "/api/api-keys"],
  ] as const)("cannot call %s %s with an X-API-Key header", async (method, path) => {
    const res = await request(app)[method](path).set("X-API-Key", apiKeySecret);
    expect(res.status).toBe(401);
  });

  it("can call the ingest route it's scoped for", async () => {
    const res = await request(app)
      .post("/api/ingest/assets")
      .set("X-API-Key", apiKeySecret)
      .send({ dryRun: true, rows: [{ name: "Scope Test Asset", type: "DATABASE", phiVolume: "1", encrypted: "true", mfaEnabled: "true" }] });
    expect(res.status).toBe(200);
  });

  it("a revoked key is rejected immediately, including for ingest itself", async () => {
    const key = await prisma.apiKey.findFirst({ where: { organizationId: ids.organizationId } });
    await request(app).post(`/api/api-keys/${key!.id}/revoke`).set("Authorization", `Bearer ${adminToken}`);

    const res = await request(app).post("/api/ingest/assets").set("X-API-Key", apiKeySecret).send({ rows: [{}] });
    expect(res.status).toBe(401);
  });
});
