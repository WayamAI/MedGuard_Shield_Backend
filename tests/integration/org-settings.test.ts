import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { computeRisk } from "../../src/services/riskScoring.js";
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

const asAdmin = (path: string) => request(app).patch(path).set("Authorization", `Bearer ${adminToken}`);

describe("GET/PATCH /api/organization/settings", () => {
  it("defaults to the documented thresholds for an org with no row yet", async () => {
    const res = await request(app).get("/api/organization/settings").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.body.data).toMatchObject({ accessStaleAfterDays: 90, assessmentCadenceDays: 365, mfaRequired: false });
  });

  it("is admin-only to change", async () => {
    const res = await request(app)
      .patch("/api/organization/settings")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ accessStaleAfterDays: 30 });
    expect(res.status).toBe(403);
  });

  it("changing accessStaleAfterDays changes which grants flag as stale, immediately", async () => {
    // The EHR asset has a grant 40 days stale (lastUsedAt set via fixture extension below).
    const identity = await prisma.identity.create({
      data: { organizationId: ids.organizationId, displayName: "Someone", kind: "USER", mfaEnabled: true },
    });
    await prisma.accessGrant.create({
      data: {
        organizationId: ids.organizationId, identityId: identity.id, assetId: ids.ehrId,
        level: "READ", grantedAt: new Date(Date.now() - 60 * 86_400_000),
        lastUsedAt: new Date(Date.now() - 40 * 86_400_000),
      },
    });

    const before = await request(app).get("/api/access?flaggedOnly=true").set("Authorization", `Bearer ${viewerToken}`);
    expect(before.body.data.some((g: { flags: string[] }) => g.flags.includes("STALE"))).toBe(false);

    await asAdmin("/api/organization/settings").send({ accessStaleAfterDays: 30 });

    const after = await request(app).get("/api/access?flaggedOnly=true").set("Authorization", `Bearer ${viewerToken}`);
    expect(after.body.data.some((g: { flags: string[] }) => g.flags.includes("STALE"))).toBe(true);
  });

  it("changing assessmentCadenceDays recomputes vendor risk and writes history once, audited", async () => {
    const vendor = await prisma.vendor.create({
      data: {
        organizationId: ids.organizationId, name: "Old Vendor", baaStatus: "SIGNED",
        lastAssessedAt: new Date(Date.now() - 100 * 86_400_000),
      },
    });
    const { score, band } = computeRisk(3, 3, 3, 1);
    await prisma.vendorRisk.create({
      data: { organizationId: ids.organizationId, vendorId: vendor.id, likelihood: 3, impact: 3, exposure: 3, controlGap: 1, score, band },
    });

    const historyBefore = await prisma.riskHistory.count({ where: { organizationId: ids.organizationId, vendorRiskId: { not: null } } });

    await asAdmin("/api/organization/settings").send({ assessmentCadenceDays: 90 });

    const risk = await prisma.vendorRisk.findUnique({ where: { vendorId: vendor.id } });
    expect(risk?.controlGap).toBeGreaterThan(1); // now overdue at a 90-day cadence

    const historyAfter = await prisma.riskHistory.count({ where: { organizationId: ids.organizationId, vendorRiskId: { not: null } } });
    expect(historyAfter).toBe(historyBefore + 1);

    // Idempotent: re-sending the same value writes no second history row.
    await asAdmin("/api/organization/settings").send({ assessmentCadenceDays: 90 });
    const historyAfterRepeat = await prisma.riskHistory.count({ where: { organizationId: ids.organizationId, vendorRiskId: { not: null } } });
    expect(historyAfterRepeat).toBe(historyAfter);

    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ids.organizationId, action: "SETTINGS_UPDATED" } });
    expect(audit?.metadata).toMatchObject({ assessmentCadenceDays: 90 });
  });
});
