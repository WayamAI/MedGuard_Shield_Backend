import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

/**
 * Automatic risk recomputation, and vendor risk history.
 *
 * Every test here mutates something through the API and then asserts three
 * things about the consequence: the score moved, a history row records the
 * movement with the triggering reason, and an audit event says why.
 */

const app = createApp();

let ids: Fixture;
let admin: string;
let analyst: string;
let vendorId: number;

/** An assessment has to exist before anything can be recalculated against it. */
async function assessAsset(assetId: number, likelihood = 3, impact = 3) {
  return request(app)
    .post(`/api/assets/${assetId}/assessment`)
    .set("Authorization", `Bearer ${analyst}`)
    .send({ likelihood, impact });
}

async function assessVendor(id: number, likelihood = 3, impact = 3) {
  return request(app)
    .post(`/api/vendors/${id}/assessment`)
    .set("Authorization", `Bearer ${analyst}`)
    .send({ likelihood, impact });
}

const historyFor = (assetId: number) =>
  prisma.riskHistory.findMany({
    where: { assetId, subjectType: "ASSET" },
    orderBy: { id: "asc" },
  });

const vendorHistoryFor = (id: number) =>
  prisma.riskHistory.findMany({
    where: { vendorId: id, subjectType: "VENDOR" },
    orderBy: { id: "asc" },
  });

beforeEach(async () => {
  ids = await seedFixture();
  admin = await tokenFor(request(app), "admin@test.local");
  analyst = await tokenFor(request(app), "analyst@test.local");

  const vendor = await prisma.vendor.create({
    data: {
      organizationId: ids.organizationId,
      name: "Auto Vendor",
      baaStatus: "SIGNED",
      lastAssessedAt: new Date(),
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the assessment split", () => {
  it("takes likelihood and impact from the assessor and derives the rest", async () => {
    const res = await assessAsset(ids.ehrId, 4, 5);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      likelihood: 4,
      impact: 5,
      exposureOverridden: false,
      controlGapOverridden: false,
    });
    // Derived, not echoed back from the request.
    expect(res.body.data.exposure).toBeGreaterThanOrEqual(1);
    expect(res.body.data.derivation).toContain("exposure");
  });

  /**
   * An assessor who supplies a factor outranks the derivation. This is the
   * escape hatch that keeps automation from overriding human judgement.
   */
  it("pins a factor the assessor supplies explicitly", async () => {
    const res = await request(app)
      .post(`/api/assets/${ids.ehrId}/assessment`)
      .set("Authorization", `Bearer ${analyst}`)
      .send({ likelihood: 3, impact: 3, exposure: 5 });

    expect(res.body.data.exposure).toBe(5);
    expect(res.body.data.exposureOverridden).toBe(true);
    expect(res.body.data.controlGapOverridden).toBe(false);
  });

  it("leaves a pinned factor alone when the graph changes", async () => {
    await request(app)
      .post(`/api/assets/${ids.ehrId}/assessment`)
      .set("Authorization", `Bearer ${analyst}`)
      .send({ likelihood: 3, impact: 3, exposure: 2 });

    // A change that would otherwise raise exposure.
    await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ phiVolume: 400_000, encrypted: false });

    const risk = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(risk.exposure).toBe(2);
    expect(risk.exposureOverridden).toBe(true);
  });

  it("releases the pin when a later assessment omits the factor", async () => {
    await request(app)
      .post(`/api/assets/${ids.ehrId}/assessment`)
      .set("Authorization", `Bearer ${analyst}`)
      .send({ likelihood: 3, impact: 3, exposure: 2 });

    await assessAsset(ids.ehrId, 3, 3);

    const risk = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(risk.exposureOverridden).toBe(false);
  });
});

describe("mutations that move risk", () => {
  it("recomputes when an asset's PHI volume changes", async () => {
    await assessAsset(ids.ehrId);
    const before = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });

    const res = await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ phiVolume: 400_000 });

    expect(res.status).toBe(200);
    expect(res.body.riskChanged ?? res.body.data.riskChanged).toBeTruthy();

    const after = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(after.exposure).toBeGreaterThan(before.exposure);
    expect(after.score).toBeGreaterThan(before.score);

    const history = await historyFor(ids.ehrId);
    expect(history.at(-1)!.reason).toBe("ASSET_CHANGED");
    expect(history.at(-1)!.previousScore).toBe(before.score);
  });

  /**
   * Access breadth only crosses an exposure threshold above three live grants,
   * so this grants four. The engine records material changes and stays silent
   * otherwise -- a single extra READ on a small asset genuinely does not move
   * the score, and writing a history row saying so would be noise.
   */
  it("recomputes when access broadens enough to matter", async () => {
    await assessAsset(ids.billingId);
    const before = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.billingId } });

    for (let i = 0; i < 4; i++) {
      const identity = await prisma.identity.create({
        data: { organizationId: ids.organizationId, displayName: `Grantee ${i}`, kind: "USER" },
      });
      await request(app)
        .post("/api/access")
        .set("Authorization", `Bearer ${admin}`)
        .send({ identityId: identity.id, assetId: ids.billingId, level: "ADMIN" });
    }

    const after = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.billingId } });
    expect(after.exposure).toBeGreaterThan(before.exposure);

    const history = await historyFor(ids.billingId);
    expect(history.some((h) => h.reason === "ACCESS_CHANGED")).toBe(true);
  });

  it("recomputes when access is revoked", async () => {
    const identity = await prisma.identity.create({
      data: { organizationId: ids.organizationId, displayName: "Leaver", kind: "USER" },
    });
    const grant = await request(app)
      .post("/api/access")
      .set("Authorization", `Bearer ${admin}`)
      .send({ identityId: identity.id, assetId: ids.ehrId, level: "ADMIN" });

    await assessAsset(ids.ehrId);
    const before = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });

    await request(app)
      .post(`/api/access/${grant.body.data.id}/revoke`)
      .set("Authorization", `Bearer ${admin}`);

    const after = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(after.exposure).toBeLessThanOrEqual(before.exposure);
    expect((await historyFor(ids.ehrId)).at(-1)!.reason).toBe("ACCESS_CHANGED");
  });

  /**
   * Archiving a leaver revokes every grant they held, so every asset they
   * could reach has to be rescored -- not just one.
   */
  it("revokes and rescores every asset a leaver could reach", async () => {
    const identity = await prisma.identity.create({
      data: { organizationId: ids.organizationId, displayName: "Departing", kind: "USER" },
    });
    for (const assetId of [ids.ehrId, ids.billingId]) {
      await request(app).post("/api/access").set("Authorization", `Bearer ${admin}`)
        .send({ identityId: identity.id, assetId, level: "ADMIN" });
      await assessAsset(assetId);
    }

    const before = {
      ehr: await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } }),
      billing: await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.billingId } }),
    };

    const res = await request(app)
      .post(`/api/identities/${identity.id}/archive`)
      .set("Authorization", `Bearer ${admin}`);

    expect(res.status).toBe(200);
    expect(res.body.data.revokedGrants).toBe(2);

    // Every reachable asset is *considered*; whether each one moves depends on
    // whether losing that grant crossed a threshold. The EHR does -- it had no
    // other elevated access -- and that is the one asserted. Billing does not,
    // and correctly gets no history row rather than a "still 1.28" entry.
    const after = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(after.exposure).toBeLessThan(before.ehr.exposure);
    expect((await historyFor(ids.ehrId)).at(-1)!.reason).toBe("ACCESS_CHANGED");

    const billingAfter = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.billingId } });
    expect(billingAfter.score).toBe(before.billing.score);
  });

  it("recomputes both sides when a vendor gains access to an asset", async () => {
    await assessAsset(ids.ehrId);
    await assessVendor(vendorId);

    await request(app)
      .put(`/api/vendors/${vendorId}/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`);

    expect((await historyFor(ids.ehrId)).at(-1)!.reason).toBe("VENDOR_ACCESS_CHANGED");
    expect((await vendorHistoryFor(vendorId)).at(-1)!.reason).toBe("VENDOR_ACCESS_CHANGED");
  });

  it("recomputes both sides when that access is removed", async () => {
    await request(app).put(`/api/vendors/${vendorId}/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`);
    await assessAsset(ids.ehrId);
    await assessVendor(vendorId);

    await request(app).delete(`/api/vendors/${vendorId}/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`);

    // The asset is no longer linked, so walking the vendor's remaining links
    // would miss it. It is recalculated explicitly.
    expect((await historyFor(ids.ehrId)).at(-1)!.reason).toBe("VENDOR_ACCESS_CHANGED");
  });

  it("recomputes a vendor when its BAA lapses", async () => {
    await assessVendor(vendorId);
    const before = await prisma.vendorRisk.findUniqueOrThrow({ where: { vendorId } });

    await request(app)
      .patch(`/api/vendors/${vendorId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ baaStatus: "EXPIRED" });

    const after = await prisma.vendorRisk.findUniqueOrThrow({ where: { vendorId } });
    expect(after.controlGap).toBeGreaterThan(before.controlGap);
    expect(after.score).toBeGreaterThan(before.score);
  });

  it("recomputes when a control is applied to an asset", async () => {
    await assessAsset(ids.ehrId);
    const before = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });

    const control = await request(app).post("/api/controls")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        name: "Encryption at Rest", description: "d", category: "ENCRYPTION",
        status: "IMPLEMENTED", effectiveness: "EFFECTIVE",
      });

    await request(app)
      .put(`/api/controls/${control.body.data.id}/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`);

    const after = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(after.controlGap).toBeLessThan(before.controlGap);
    expect((await historyFor(ids.ehrId)).at(-1)!.reason).toBe("CONTROL_CHANGED");
  });

  it("recomputes every asset when a control's effectiveness is downgraded", async () => {
    const control = await request(app).post("/api/controls")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        name: "Shared Control", description: "d", category: "ACCESS",
        status: "IMPLEMENTED", effectiveness: "EFFECTIVE",
      });
    const controlId = control.body.data.id;

    for (const assetId of [ids.ehrId, ids.billingId]) {
      await request(app).put(`/api/controls/${controlId}/assets/${assetId}`)
        .set("Authorization", `Bearer ${admin}`);
      await assessAsset(assetId);
    }

    // An ANALYST may record this: it is assessment, not configuration.
    await request(app)
      .patch(`/api/controls/${controlId}`)
      .set("Authorization", `Bearer ${analyst}`)
      .send({ effectiveness: "INEFFECTIVE" });

    for (const assetId of [ids.ehrId, ids.billingId]) {
      expect((await historyFor(assetId)).at(-1)!.reason).toBe("CONTROL_CHANGED");
    }
  });

  it("recomputes when a severe threat opens and again when it closes", async () => {
    await assessAsset(ids.ehrId);
    const baseline = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });

    const threat = await request(app).post("/api/threats")
      .set("Authorization", `Bearer ${analyst}`)
      .send({ assetId: ids.ehrId, severity: "CRITICAL", title: "Live incident", description: "d" });

    const raised = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(raised.exposure).toBeGreaterThan(baseline.exposure);

    await request(app)
      .post(`/api/threats/${threat.body.data.id}/status`)
      .set("Authorization", `Bearer ${analyst}`)
      .send({ status: "RESOLVED" });

    const closed = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(closed.exposure).toBe(baseline.exposure);
    expect((await historyFor(ids.ehrId)).at(-1)!.reason).toBe("THREAT_CHANGED");
  });
});

describe("mutations that must NOT move risk", () => {
  it("does not rescore a purely descriptive asset edit", async () => {
    await assessAsset(ids.ehrId);
    const before = await historyFor(ids.ehrId);

    await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ name: "Renamed" });

    expect(await historyFor(ids.ehrId)).toHaveLength(before.length);
  });

  it("does not rescore an unassessed asset into existence", async () => {
    const fresh = await prisma.asset.create({
      data: { organizationId: ids.organizationId, name: "Never Assessed", type: "API" },
    });

    await request(app)
      .patch(`/api/assets/${fresh.id}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ phiVolume: 900_000, encrypted: false });

    // Still unassessed. Deriving two factors and inventing the other two would
    // be fabricating an assessment nobody made.
    expect(await prisma.risk.findUnique({ where: { assetId: fresh.id } })).toBeNull();
    expect(await historyFor(fresh.id)).toHaveLength(0);
  });

  it("writes no history row when a recalculation changes nothing", async () => {
    await assessAsset(ids.ehrId);
    const before = await historyFor(ids.ehrId);

    // Setting a field to the value it already holds.
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: ids.ehrId } });
    await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ phiVolume: asset.phiVolume });

    expect(await historyFor(ids.ehrId)).toHaveLength(before.length);
  });

  /**
   * The invariant that makes triggers safe: recalculation reads the graph and
   * writes only Risk, RiskHistory and AuditEvent. If it mutated an asset it
   * could trigger itself, and one edit would loop.
   */
  it("does not loop: one mutation produces exactly one history row", async () => {
    await assessAsset(ids.ehrId);
    const before = await historyFor(ids.ehrId);

    await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ phiVolume: 400_000 });

    expect((await historyFor(ids.ehrId)).length).toBe(before.length + 1);
  });
});

describe("the audit trail explains automatic rescores", () => {
  it("records the trigger and the reasons, not a narrative", async () => {
    await assessAsset(ids.billingId);

    await request(app)
      .patch(`/api/assets/${ids.billingId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ phiVolume: 300_000 });

    const events = await prisma.auditEvent.findMany({
      where: { action: "RISK_RECOMPUTED", entityId: ids.billingId },
      orderBy: { id: "desc" },
    });

    expect(events.length).toBeGreaterThan(0);
    const meta = events[0]!.metadata as Record<string, unknown>;
    expect(meta.trigger).toBe("automatic");
    expect(meta.derivation).toContain("300,000 PHI records");
    expect(meta.previousScore).not.toBeNull();
  });
});

describe("vendor risk history", () => {
  it("records a vendor's first assessment", async () => {
    await assessVendor(vendorId, 4, 4);

    const history = await vendorHistoryFor(vendorId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      subjectType: "VENDOR",
      assetId: null,
      previousScore: null,
      reason: "INITIAL_ASSESSMENT",
    });
  });

  it("records movement with the previous score", async () => {
    await assessVendor(vendorId, 3, 3);
    const first = await prisma.vendorRisk.findUniqueOrThrow({ where: { vendorId } });

    await assessVendor(vendorId, 5, 5);

    const history = await vendorHistoryFor(vendorId);
    expect(history).toHaveLength(2);
    expect(history[1]!.previousScore).toBe(first.score);
    expect(history[1]!.reason).toBe("MANUAL_ASSESSMENT");
  });

  it("is served with a precomputed delta and the actor", async () => {
    await assessVendor(vendorId, 3, 3);
    await assessVendor(vendorId, 5, 5);

    const res = await request(app)
      .get(`/api/vendors/${vendorId}/risk-history`)
      .set("Authorization", `Bearer ${analyst}`);

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, total: 2 });

    const latest = res.body.data[0];
    expect(latest.subjectType).toBe("VENDOR");
    expect(latest.vendorName).toBeUndefined(); // generic shape
    expect(latest.subjectName).toBe("Auto Vendor");
    expect(latest.delta).toBeGreaterThan(0);
    expect(latest.changedBy.email).toBe("analyst@test.local");
  });

  it("404s another tenant's vendor rather than returning an empty page", async () => {
    const outsider = await tokenFor(request(app), "outsider@rival.local");
    const res = await request(app)
      .get(`/api/vendors/${vendorId}/risk-history`)
      .set("Authorization", `Bearer ${outsider}`);

    expect(res.status).toBe(404);
  });

  it("keeps asset and vendor history separable on the estate-wide endpoint", async () => {
    await assessAsset(ids.ehrId);
    await assessVendor(vendorId);

    const all = await request(app).get("/api/risks/history")
      .set("Authorization", `Bearer ${analyst}`);
    const vendorsOnly = await request(app).get("/api/risks/history?subjectType=VENDOR")
      .set("Authorization", `Bearer ${analyst}`);

    expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
    expect(vendorsOnly.body.data.every((e: { subjectType: string }) => e.subjectType === "VENDOR"))
      .toBe(true);
  });

  it("shares one table with asset history rather than duplicating it", async () => {
    await assessAsset(ids.ehrId);
    await assessVendor(vendorId);

    const rows = await prisma.riskHistory.findMany({
      where: { organizationId: ids.organizationId },
    });

    expect(rows.some((r) => r.subjectType === "ASSET" && r.assetId !== null)).toBe(true);
    expect(rows.some((r) => r.subjectType === "VENDOR" && r.vendorId !== null)).toBe(true);
    // Exactly one subject per row.
    expect(rows.every((r) => (r.assetId === null) !== (r.vendorId === null))).toBe(true);
  });
});
