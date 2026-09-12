import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor } from "../helpers.js";

const app = createApp();
let token: string;
let ids: Awaited<ReturnType<typeof seedFixture>>;

beforeAll(async () => {
  ids = await seedFixture();
  token = await tokenFor(request(app), "admin@test.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = () => request(app).get("/api/assets").set("Authorization", `Bearer ${token}`);

/**
 * Every protected endpoint must refuse an anonymous caller, a malformed token,
 * and a token signed with the wrong key. Table-driven so a new route cannot be
 * added without someone noticing it is missing from this list.
 */
const PROTECTED: Array<[string, "get" | "post", string]> = [
  ["assets list", "get", "/api/assets"],
  ["asset detail", "get", "/api/assets/1"],
  ["dataflows", "get", "/api/dataflows"],
  ["risks", "get", "/api/risks"],
  ["recompute", "post", "/api/risks/1/recompute"],
  ["me", "get", "/api/auth/me"],
];

describe("authentication is enforced on every /api route", () => {
  for (const [label, method, path] of PROTECTED) {
    it(`${label} rejects an anonymous request`, async () => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe("Authentication required");
    });

    it(`${label} rejects a malformed token`, async () => {
      const res = await request(app)[method](path).set("Authorization", "Bearer not-a-jwt");
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe("Invalid or expired session token");
    });
  }

  it("health is deliberately outside the gate", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
  });
});

describe("GET /api/assets", () => {
  it("returns both fixture assets with their current risk", async () => {
    const res = await auth();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);

    const billing = res.body.data.find((a: { name: string }) => a.name === "Test Billing");
    expect(billing).toMatchObject({
      type: "DATABASE",
      encrypted: false,
      mfaEnabled: false,
      risk: { score: 100, band: "EXTREME" },
    });
  });
});

describe("GET /api/assets/:id", () => {
  it("returns PHI types, the full risk breakdown, and both flow directions", async () => {
    const res = await request(app)
      .get(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Test EHR");
    expect(res.body.data.phiTypes).toEqual([
      { id: ids.phiTypeId, name: "Clinical", sensitivity: "HIGH", recordsPerDay: 900 },
    ]);
    expect(res.body.data.risk).toMatchObject({
      likelihood: 3, impact: 3, exposure: 3, controlGap: 2, score: 8.64, band: "LOW",
    });
    expect(res.body.data.flows.outbound).toHaveLength(1);
    expect(res.body.data.flows.inbound).toHaveLength(0);
  });

  it("404s for an id that does not exist", async () => {
    const res = await request(app).get("/api/assets/999999").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("400s for a non-numeric id", async () => {
    const res = await request(app).get("/api/assets/abc").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400s for a negative id", async () => {
    const res = await request(app).get("/api/assets/-1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/dataflows", () => {
  it("shapes each flow for the Sankey, with names rather than ids", async () => {
    const res = await request(app).get("/api/dataflows").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      source: "Test EHR",
      target: "Test Billing",
      phiType: "Clinical",
      recordsPerDay: 250,
      encrypted: false,
      status: "violation",
    });
  });

  it("derives status from the target asset's MFA, not the source's", async () => {
    // Fixture: EHR has MFA on, Billing has it off. An encrypted flow into
    // Billing must warn; the same flow reversed into the EHR must be ok.
    await prisma.dataFlow.updateMany({ data: { encrypted: true } });
    const warn = await request(app).get("/api/dataflows").set("Authorization", `Bearer ${token}`);
    expect(warn.body.data[0].status).toBe("warn");

    await prisma.dataFlow.updateMany({
      data: { sourceAssetId: ids.billingId, targetAssetId: ids.ehrId },
    });
    const ok = await request(app).get("/api/dataflows").set("Authorization", `Bearer ${token}`);
    expect(ok.body.data[0].status).toBe("ok");

    // Restore the fixture for any test that runs after this one.
    await prisma.dataFlow.updateMany({
      data: { sourceAssetId: ids.ehrId, targetAssetId: ids.billingId, encrypted: false },
    });
  });
});

describe("GET /api/risks", () => {
  it("returns matrix-shaped rows sorted by score", async () => {
    const res = await request(app).get("/api/risks").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      assetName: "Test Billing", likelihood: 5, impact: 5, band: "EXTREME", score: 100,
    });
    expect(res.body.data[1].band).toBe("LOW");
  });
});

describe("POST /api/risks/:assetId/recompute", () => {
  it("rescores from stored inputs and reports the previous value", async () => {
    await prisma.risk.updateMany({
      where: { assetId: ids.ehrId },
      data: { likelihood: 5, impact: 5, exposure: 5, controlGap: 4 },
    });

    const res = await request(app)
      .post(`/api/risks/${ids.ehrId}/recompute`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      assetName: "Test EHR",
      score: 80,
      band: "CRITICAL",
      previous: { score: 8.64, band: "LOW" },
    });
  });

  it("persists the recomputed value rather than only returning it", async () => {
    const stored = await prisma.risk.findFirst({ where: { assetId: ids.ehrId } });
    expect(stored?.score).toBe(80);
    expect(stored?.band).toBe("CRITICAL");
  });

  it("404s when the asset does not exist", async () => {
    const res = await request(app)
      .post("/api/risks/999999/recompute")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("400s for a non-numeric assetId", async () => {
    const res = await request(app)
      .post("/api/risks/abc/recompute")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("unmatched routes", () => {
  it("return a structured 404, not an HTML error page", async () => {
    const res = await request(app).get("/api/nope").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("never leak a stack trace", async () => {
    const res = await request(app).get("/api/assets/999999").set("Authorization", `Bearer ${token}`);
    expect(JSON.stringify(res.body)).not.toContain("at ");
    expect(res.body.error.stack).toBeUndefined();
  });
});
