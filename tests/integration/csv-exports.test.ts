import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

const app = createApp();

let ids: Fixture;
let adminToken: string;

beforeEach(async () => {
  ids = await seedFixture();
  adminToken = await tokenFor(request(app), "admin@test.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${adminToken}`);

describe("CSV exports", () => {
  it.each([
    "/api/assets", "/api/vendors", "/api/access", "/api/threats", "/api/risks",
    "/api/remediations", "/api/controls", "/api/policies", "/api/phi-inventory", "/api/audit",
  ])("exports %s as text/csv with a header row and audits the export", async (path) => {
    const res = await get(`${path}?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const lines = res.text.split("\r\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1); // header, plus rows if any exist

    const audit = await prisma.auditEvent.findFirst({
      where: { organizationId: ids.organizationId, action: "DATA_EXPORTED" },
      orderBy: { id: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("escapes a formula-injection attempt in an exported cell", async () => {
    await prisma.asset.create({
      data: {
        organizationId: ids.organizationId, name: "=cmd|'/C calc'!A1", type: "OTHER",
        phiVolume: 1, encrypted: true, mfaEnabled: true,
      },
    });
    const res = await get("/api/assets?format=csv");
    expect(res.text).toContain("'=cmd|'/C calc'!A1");
    // The raw, unescaped formula string must never appear at the start of a cell.
    expect(res.text).not.toMatch(/,=cmd/);
  });

  it("export honours the same filters as the JSON list", async () => {
    const jsonRes = await get("/api/threats?severity=CRITICAL");
    const csvRes = await get("/api/threats?severity=CRITICAL&format=csv");
    const csvRows = csvRes.text.split("\r\n").filter(Boolean).length - 1; // minus header
    expect(csvRows).toBe(jsonRes.body.data.length);
  });

  it("the audit export is admin-only", async () => {
    const viewerToken = await tokenFor(request(app), "viewer@test.local");
    const res = await request(app).get("/api/audit?format=csv").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });
});
