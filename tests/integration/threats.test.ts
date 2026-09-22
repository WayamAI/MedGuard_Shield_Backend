import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor } from "../helpers.js";

const app = createApp();
const HOUR = 3_600_000;
let token: string;
let ids: Awaited<ReturnType<typeof seedFixture>>;

const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

beforeEach(async () => {
  ids = await seedFixture();
  token = await tokenFor(request(app), "admin@test.local");

  await prisma.threat.createMany({
    data: [
      { organizationId: ids.organizationId, assetId: ids.billingId, severity: "CRITICAL", status: "INVESTIGATING", title: "Open critical", description: "d", detectedAt: hoursAgo(4) },
      { organizationId: ids.organizationId, assetId: ids.ehrId, severity: "LOW", status: "OPEN", title: "Open low", description: "d", detectedAt: hoursAgo(2) },
      { organizationId: ids.organizationId, assetId: ids.ehrId, severity: "CRITICAL", status: "RESOLVED", title: "Resolved critical", description: "d", detectedAt: hoursAgo(50), resolvedAt: hoursAgo(20) },
      { organizationId: ids.organizationId, assetId: ids.billingId, severity: "HIGH", status: "FALSE_POSITIVE", title: "Noise", description: "d", detectedAt: hoursAgo(90), resolvedAt: hoursAgo(80) },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The threat fields these assertions read. */
type ThreatRow = { title: string; open: boolean; hoursSinceDetection: number };

const get = () => request(app).get("/api/threats").set("Authorization", `Bearer ${token}`);

/**
 * The summary moved to its own endpoint when the list became paginated. A
 * summary computed over one page would quietly mean something different from
 * the estate-wide figure the dashboard needs.
 */
const getSummary = () =>
  request(app).get("/api/threats/summary").set("Authorization", `Bearer ${token}`);
const byTitle = (rows: ThreatRow[], title: string) =>
  rows.find((r) => r.title === title) as ThreatRow;

describe("GET /api/threats", () => {
  it("requires authentication", async () => {
    expect((await request(app).get("/api/threats")).status).toBe(401);
  });

  it("returns every threat with its asset name", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.data[0].assetName).toBeTypeOf("string");
  });

  it("summarises by severity and status", async () => {
    const summaryBody = (await getSummary()).body.data;
    expect(summaryBody).toMatchObject({
      total: 4,
      open: 2,
      openCritical: 1,
      bySeverity: { CRITICAL: 2, HIGH: 1, MEDIUM: 0, LOW: 1 },
      byStatus: { OPEN: 1, INVESTIGATING: 1, RESOLVED: 1, FALSE_POSITIVE: 1 },
    });
  });

  it("counts only unresolved criticals in openCritical", async () => {
    // Two criticals exist but one is RESOLVED, so the headline number is 1.
    const summaryBody = (await getSummary()).body.data;
    expect(summaryBody.bySeverity.CRITICAL).toBe(2);
    expect(summaryBody.openCritical).toBe(1);
  });

  it("puts unresolved threats before resolved ones regardless of severity", async () => {
    const rows = (await get()).body.data;
    expect(rows[0].title).toBe("Open critical");
    // The open LOW must still outrank the resolved CRITICAL.
    expect(rows[1].title).toBe("Open low");
    expect(rows[2].title).toBe("Resolved critical");
  });

  it("marks open vs closed explicitly rather than leaving clients to infer it", async () => {
    const rows = (await get()).body.data;
    expect(byTitle(rows, "Open critical").open).toBe(true);
    expect(byTitle(rows, "Resolved critical").open).toBe(false);
    expect(byTitle(rows, "Noise").open).toBe(false);
  });

  it("reports hours since detection", async () => {
    const row = byTitle((await get()).body.data, "Open critical");
    expect(row.hoursSinceDetection).toBe(4);
  });

  it("keeps FALSE_POSITIVE distinct from RESOLVED", async () => {
    const s = (await getSummary()).body.data.byStatus;
    expect(s.RESOLVED).toBe(1);
    expect(s.FALSE_POSITIVE).toBe(1);
  });

  it("is readable by VIEWER", async () => {
    const viewer = await tokenFor(request(app), "viewer@test.local");
    const res = await request(app).get("/api/threats").set("Authorization", `Bearer ${viewer}`);
    expect(res.status).toBe(200);
  });
});
