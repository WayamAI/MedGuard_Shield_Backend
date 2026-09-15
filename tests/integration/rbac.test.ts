import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor } from "../helpers.js";

const app = createApp();

let tokens: Record<"ADMIN" | "ANALYST" | "VIEWER", string>;
let ids: Awaited<ReturnType<typeof seedFixture>>;

beforeEach(async () => {
  ids = await seedFixture();
  tokens = {
    ADMIN: await tokenFor(request(app), "admin@test.local"),
    ANALYST: await tokenFor(request(app), "analyst@test.local"),
    VIEWER: await tokenFor(request(app), "viewer@test.local"),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

const newAsset = (name: string) => ({ name, type: "API" as const, phiVolume: 10 });

describe("POST /api/assets — role gate", () => {
  it("allows ADMIN", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send(newAsset("Created By Admin"));

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Created By Admin", type: "API", phiVolume: 10 });
    expect(res.body.data.id).toBeTypeOf("number");
  });

  it("allows ANALYST", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send(newAsset("Created By Analyst"));
    expect(res.status).toBe(201);
  });

  it("refuses VIEWER with 403 and names the required roles", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.VIEWER}`)
      .send(newAsset("Created By Viewer"));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message).toContain("ADMIN");
  });

  it("does not create the row when VIEWER is refused", async () => {
    await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.VIEWER}`)
      .send(newAsset("Should Not Exist"));

    expect(await prisma.asset.findUnique({ where: { name: "Should Not Exist" } })).toBeNull();
  });

  it("refuses an anonymous caller with 401, not 403", async () => {
    const res = await request(app).post("/api/assets").send(newAsset("Anon"));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/assets/:id — role gate", () => {
  it("allows ADMIN and applies a partial update", async () => {
    const res = await request(app)
      .patch(`/api/assets/${ids.billingId}`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ encrypted: true });

    expect(res.status).toBe(200);
    expect(res.body.data.encrypted).toBe(true);
    // Untouched fields must survive.
    expect(res.body.data.name).toBe("Test Billing");
    expect(res.body.data.phiVolume).toBe(500);
  });

  it("allows ANALYST", async () => {
    const res = await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({ mfaEnabled: false });
    expect(res.status).toBe(200);
  });

  it("refuses VIEWER with 403 and leaves the row unchanged", async () => {
    const res = await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${tokens.VIEWER}`)
      .send({ mfaEnabled: false });

    expect(res.status).toBe(403);
    const row = await prisma.asset.findUnique({ where: { id: ids.ehrId } });
    expect(row?.mfaEnabled).toBe(true);
  });
});

describe("POST /api/risks/:assetId/recompute — role gate", () => {
  it("allows ADMIN", async () => {
    const res = await request(app)
      .post(`/api/risks/${ids.ehrId}/recompute`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`);
    expect(res.status).toBe(200);
  });

  it("allows ANALYST", async () => {
    const res = await request(app)
      .post(`/api/risks/${ids.ehrId}/recompute`)
      .set("Authorization", `Bearer ${tokens.ANALYST}`);
    expect(res.status).toBe(200);
  });

  it("refuses VIEWER with 403 and names the required roles", async () => {
    const res = await request(app)
      .post(`/api/risks/${ids.ehrId}/recompute`)
      .set("Authorization", `Bearer ${tokens.VIEWER}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message).toContain("ADMIN");
  });

  it("does not touch the stored risk when VIEWER is refused", async () => {
    // The fixture scores the EHR asset 3/3/3/2; recompute is idempotent over
    // unchanged inputs, so computedAt is the only field that would move.
    const before = await prisma.risk.findFirst({ where: { assetId: ids.ehrId } });

    await request(app)
      .post(`/api/risks/${ids.ehrId}/recompute`)
      .set("Authorization", `Bearer ${tokens.VIEWER}`);

    const after = await prisma.risk.findFirst({ where: { assetId: ids.ehrId } });
    expect(after?.computedAt).toEqual(before?.computedAt);
  });

  it("refuses an anonymous caller with 401, not 403", async () => {
    const res = await request(app).post(`/api/risks/${ids.ehrId}/recompute`);
    expect(res.status).toBe(401);
  });
});

describe("write validation", () => {
  it("400s a missing name", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ type: "API" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400s an invalid asset type", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ name: "Bad Type", type: "MAINFRAME" });
    expect(res.status).toBe(400);
  });

  it("400s a negative phiVolume", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ name: "Negative", type: "API", phiVolume: -5 });
    expect(res.status).toBe(400);
  });

  it("400s a PATCH with an empty body rather than silently doing nothing", async () => {
    const res = await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("409s a duplicate name rather than surfacing a Prisma error as a 500", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send(newAsset("Test EHR"));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("404s a PATCH against an unknown id", async () => {
    const res = await request(app)
      .patch("/api/assets/999999")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ encrypted: true });
    expect(res.status).toBe(404);
  });
});
