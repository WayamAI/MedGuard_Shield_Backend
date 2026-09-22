import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

/**
 * Lifecycles: assessment and risk history, threat triage, control coverage,
 * remediation workflow, and archive semantics.
 *
 * These cover the capabilities that did not exist before — the ones a customer
 * demonstration has to walk through end to end.
 */

const app = createApp();

let ids: Fixture;
let admin: string;
let analyst: string;
let viewer: string;

beforeEach(async () => {
  ids = await seedFixture();
  admin = await tokenFor(request(app), "admin@test.local");
  analyst = await tokenFor(request(app), "analyst@test.local");
  viewer = await tokenFor(request(app), "viewer@test.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("assessment and risk history", () => {
  it("creates a first assessment through the API", async () => {
    // The asset has no risk row; this is the path that did not exist before.
    const fresh = await prisma.asset.create({
      data: { organizationId: ids.organizationId, name: "Unassessed", type: "API" },
    });

    const res = await request(app)
      .post(`/api/assets/${fresh.id}/assessment`)
      .set(auth(analyst))
      .send({ likelihood: 4, impact: 4, exposure: 4, controlGap: 3 });

    expect(res.status).toBe(201);
    expect(res.body.data.score).toBe(30.72);
    expect(res.body.data.band).toBe("MODERATE");
    expect(res.body.data.previous).toBeNull();
  });

  it("keeps one risk row per asset and records the movement", async () => {
    await request(app).post(`/api/assets/${ids.ehrId}/assessment`).set(auth(analyst))
      .send({ likelihood: 5, impact: 5, exposure: 5, controlGap: 5 });

    const risks = await prisma.risk.findMany({ where: { assetId: ids.ehrId } });
    expect(risks).toHaveLength(1);
    expect(risks[0]!.score).toBe(100);

    const history = await prisma.riskHistory.findMany({ where: { assetId: ids.ehrId } });
    expect(history).toHaveLength(1);
    expect(history[0]!.previousScore).toBe(8.64);
    expect(history[0]!.score).toBe(100);
    expect(history[0]!.reason).toBe("MANUAL_ASSESSMENT");
  });

  it("exposes the movement with a precomputed delta", async () => {
    await request(app).post(`/api/assets/${ids.ehrId}/assessment`).set(auth(analyst))
      .send({ likelihood: 5, impact: 5, exposure: 5, controlGap: 5 });

    const res = await request(app)
      .get(`/api/assets/${ids.ehrId}/risk-history`)
      .set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      previousScore: 8.64, score: 100, delta: 91.36, reason: "MANUAL_ASSESSMENT",
    });
    expect(res.body.data[0].changedBy.email).toBe("analyst@test.local");
  });

  /**
   * A recompute that moved nothing is not history. Recording it would bury the
   * changes that matter under rows saying "still 8.64".
   */
  it("does not write a history row when a recompute changes nothing", async () => {
    await request(app).post(`/api/assets/${ids.ehrId}/recompute`).set(auth(analyst));
    expect(await prisma.riskHistory.count()).toBe(0);
  });

  it("still refuses to invent a first assessment via recompute", async () => {
    const fresh = await prisma.asset.create({
      data: { organizationId: ids.organizationId, name: "Never assessed", type: "API" },
    });

    const res = await request(app).post(`/api/assets/${fresh.id}/recompute`).set(auth(analyst));
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain("assessment");
  });

  it("refuses an assessment from a VIEWER", async () => {
    const res = await request(app)
      .post(`/api/assets/${ids.ehrId}/assessment`)
      .set(auth(viewer))
      .send({ likelihood: 1, impact: 1, exposure: 1, controlGap: 1 });

    expect(res.status).toBe(403);
    expect(await prisma.riskHistory.count()).toBe(0);
  });

  it("rejects out-of-range judgements", async () => {
    const res = await request(app)
      .post(`/api/assets/${ids.ehrId}/assessment`)
      .set(auth(analyst))
      .send({ likelihood: 6, impact: 1, exposure: 1, controlGap: 1 });

    expect(res.status).toBe(400);
  });

  it("keeps the deprecated recompute alias working", async () => {
    const res = await request(app)
      .post(`/api/risks/${ids.ehrId}/recompute`)
      .set(auth(analyst));
    expect(res.status).toBe(200);
    expect(res.body.data.assetId).toBe(ids.ehrId);
  });
});

describe("threat triage", () => {
  let threatId: number;

  beforeEach(async () => {
    const threat = await prisma.threat.create({
      data: {
        organizationId: ids.organizationId, assetId: ids.ehrId,
        severity: "HIGH", title: "Triage me", description: "d",
      },
    });
    threatId = threat.id;
  });

  it("moves OPEN to INVESTIGATING to RESOLVED and stamps resolvedAt", async () => {
    for (const status of ["INVESTIGATING", "RESOLVED"]) {
      const res = await request(app)
        .post(`/api/threats/${threatId}/status`)
        .set(auth(analyst))
        .send({ status });
      expect(res.status).toBe(200);
    }

    const threat = await prisma.threat.findUniqueOrThrow({ where: { id: threatId } });
    expect(threat.status).toBe("RESOLVED");
    expect(threat.resolvedAt).not.toBeNull();
  });

  it("clears resolvedAt when a closed threat is reopened", async () => {
    await request(app).post(`/api/threats/${threatId}/status`).set(auth(analyst))
      .send({ status: "RESOLVED" });
    await request(app).post(`/api/threats/${threatId}/status`).set(auth(analyst))
      .send({ status: "OPEN" });

    const threat = await prisma.threat.findUniqueOrThrow({ where: { id: threatId } });
    expect(threat.status).toBe("OPEN");
    expect(threat.resolvedAt).toBeNull();
  });

  /**
   * Refusing an illegal move with the legal ones named lets a UI render the
   * right buttons instead of discovering the state machine by trial and error.
   */
  it("refuses an illegal transition and names the legal ones", async () => {
    await request(app).post(`/api/threats/${threatId}/status`).set(auth(analyst))
      .send({ status: "RESOLVED" });

    const res = await request(app)
      .post(`/api/threats/${threatId}/status`)
      .set(auth(analyst))
      .send({ status: "INVESTIGATING" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("OPEN");
  });

  it("refuses a no-op transition", async () => {
    const res = await request(app)
      .post(`/api/threats/${threatId}/status`)
      .set(auth(analyst))
      .send({ status: "OPEN" });
    expect(res.status).toBe(409);
  });

  it("advertises the legal moves on the detail response", async () => {
    const res = await request(app).get(`/api/threats/${threatId}`).set(auth(viewer));
    expect(res.body.data.allowedTransitions).toEqual(
      expect.arrayContaining(["INVESTIGATING", "RESOLVED", "FALSE_POSITIVE"]),
    );
  });

  it("refuses a transition from a VIEWER", async () => {
    const res = await request(app)
      .post(`/api/threats/${threatId}/status`)
      .set(auth(viewer))
      .send({ status: "RESOLVED" });
    expect(res.status).toBe(403);
  });
});

describe("controls", () => {
  it("creates a control and applies it to an asset", async () => {
    const control = await request(app)
      .post("/api/controls")
      .set(auth(admin))
      .send({ name: "MFA", description: "Require MFA", category: "ACCESS", status: "IMPLEMENTED", effectiveness: "EFFECTIVE" });

    expect(control.status).toBe(201);

    const link = await request(app)
      .put(`/api/controls/${control.body.data.id}/assets/${ids.ehrId}`)
      .set(auth(admin));
    expect(link.status).toBe(200);

    const detail = await request(app).get(`/api/assets/${ids.ehrId}`).set(auth(viewer));
    expect(detail.body.data.controls.map((c: { name: string }) => c.name)).toContain("MFA");
  });

  /**
   * The control-gap link is evidential, not automatic. A score that moved
   * because a checkbox changed is not one anybody could defend in an audit, so
   * the endpoint offers a number and applying it is a separate, explicit act.
   */
  it("suggests a control gap without applying it", async () => {
    const control = await request(app).post("/api/controls").set(auth(admin))
      .send({ name: "Encryption", description: "At rest", category: "ENCRYPTION", status: "IMPLEMENTED", effectiveness: "EFFECTIVE" });
    await request(app).put(`/api/controls/${control.body.data.id}/assets/${ids.ehrId}`).set(auth(admin));

    const before = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });

    const res = await request(app)
      .get(`/api/assets/${ids.ehrId}/control-evidence`)
      .set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.effectiveControls).toBe(1);
    expect(res.body.data.suggestedControlGap).toBeGreaterThanOrEqual(1);
    expect(res.body.data.applied).toBe(false);
    expect(res.body.data.basis).toBeTypeOf("string");

    // Nothing moved.
    const after = await prisma.risk.findUniqueOrThrow({ where: { assetId: ids.ehrId } });
    expect(after.controlGap).toBe(before.controlGap);
    expect(after.score).toBe(before.score);
  });

  it("archives rather than deletes", async () => {
    const control = await request(app).post("/api/controls").set(auth(admin))
      .send({ name: "Temp", description: "d", category: "GOVERNANCE" });

    const res = await request(app)
      .post(`/api/controls/${control.body.data.id}/archive`)
      .set(auth(admin));
    expect(res.status).toBe(200);

    expect(await prisma.control.findUnique({ where: { id: control.body.data.id } })).not.toBeNull();

    const list = await request(app).get("/api/controls").set(auth(viewer));
    expect(list.body.data.map((c: { name: string }) => c.name)).not.toContain("Temp");
  });
});

describe("remediation workflow", () => {
  const openFinding = {
    title: "Unencrypted PHI at rest",
    description: "The billing database stores PHI without encryption.",
    recommendation: "Enable AES-256 and re-key the volume.",
    severity: "CRITICAL",
    source: "RISK",
  };

  it("creates a finding linked to the asset that raised it", async () => {
    const res = await request(app)
      .post("/api/remediations")
      .set(auth(analyst))
      .send({ ...openFinding, assetId: ids.billingId });

    expect(res.status).toBe(201);

    const detail = await request(app)
      .get(`/api/remediations/${res.body.data.id}`)
      .set(auth(viewer));
    expect(detail.body.data.subject.asset.id).toBe(ids.billingId);
    expect(detail.body.data.open).toBe(true);
  });

  it("assigns work to a member of the organization", async () => {
    const created = await request(app).post("/api/remediations").set(auth(analyst))
      .send(openFinding);

    const res = await request(app)
      .post(`/api/remediations/${created.body.data.id}/assign`)
      .set(auth(analyst))
      .send({ ownerId: ids.adminUserId });

    expect(res.status).toBe(200);
    expect(res.body.data.ownerId).toBe(ids.adminUserId);
  });

  it("refuses to assign work to someone outside the organization", async () => {
    const created = await request(app).post("/api/remediations").set(auth(analyst))
      .send(openFinding);

    const res = await request(app)
      .post(`/api/remediations/${created.body.data.id}/assign`)
      .set(auth(analyst))
      .send({ ownerId: ids.outsiderUserId });

    expect(res.status).toBe(404);
  });

  it("walks OPEN to IN_PROGRESS to RESOLVED and stamps resolvedAt", async () => {
    const created = await request(app).post("/api/remediations").set(auth(analyst))
      .send(openFinding);
    const id = created.body.data.id;

    for (const status of ["IN_PROGRESS", "RESOLVED"]) {
      const res = await request(app).post(`/api/remediations/${id}/status`)
        .set(auth(analyst)).send({ status });
      expect(res.status).toBe(200);
    }

    const row = await prisma.remediation.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("RESOLVED");
    expect(row.resolvedAt).not.toBeNull();
  });

  /**
   * The point of the whole subsystem: resolving work records a claim about
   * people, and must not quietly change the estate. This is what replaces the
   * frontend's fabricated "Violation resolved, encryption applied."
   */
  it("does not alter the underlying asset when work is marked resolved", async () => {
    const created = await request(app).post("/api/remediations").set(auth(analyst))
      .send({ ...openFinding, assetId: ids.billingId });

    const before = await prisma.asset.findUniqueOrThrow({ where: { id: ids.billingId } });
    expect(before.encrypted).toBe(false);

    await request(app).post(`/api/remediations/${created.body.data.id}/status`)
      .set(auth(analyst)).send({ status: "RESOLVED" });

    const after = await prisma.asset.findUniqueOrThrow({ where: { id: ids.billingId } });
    expect(after.encrypted).toBe(false);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("keeps ACCEPTED distinct from RESOLVED", async () => {
    const created = await request(app).post("/api/remediations").set(auth(analyst))
      .send(openFinding);

    await request(app).post(`/api/remediations/${created.body.data.id}/status`)
      .set(auth(analyst)).send({ status: "ACCEPTED" });

    const summary = await request(app).get("/api/remediations/summary").set(auth(viewer));
    expect(summary.body.data.byStatus.ACCEPTED).toBe(1);
    expect(summary.body.data.byStatus.RESOLVED).toBe(0);
  });

  it("reopens closed work", async () => {
    const created = await request(app).post("/api/remediations").set(auth(analyst))
      .send(openFinding);
    const id = created.body.data.id;

    await request(app).post(`/api/remediations/${id}/status`).set(auth(analyst))
      .send({ status: "RESOLVED" });
    const res = await request(app).post(`/api/remediations/${id}/status`).set(auth(analyst))
      .send({ status: "REOPENED" });

    expect(res.status).toBe(200);
    expect(res.body.data.resolvedAt).toBeNull();
  });

  it("flags overdue work", async () => {
    await request(app).post("/api/remediations").set(auth(analyst))
      .send({ ...openFinding, dueAt: new Date(Date.now() - 86_400_000).toISOString() });

    const res = await request(app).get("/api/remediations?overdueOnly=true").set(auth(viewer));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].overdue).toBe(true);
  });
});

describe("archive semantics", () => {
  it("hides an archived asset from the default list but keeps the row", async () => {
    await request(app).post(`/api/assets/${ids.billingId}/archive`).set(auth(admin));

    const listed = await request(app).get("/api/assets").set(auth(viewer));
    expect(listed.body.data.map((a: { id: number }) => a.id)).not.toContain(ids.billingId);

    const withArchived = await request(app)
      .get("/api/assets?includeArchived=true")
      .set(auth(viewer));
    expect(withArchived.body.data.map((a: { id: number }) => a.id)).toContain(ids.billingId);

    expect(await prisma.asset.findUnique({ where: { id: ids.billingId } })).not.toBeNull();
  });

  it("keeps the archived asset's risk history intact", async () => {
    await request(app).post(`/api/assets/${ids.ehrId}/assessment`).set(auth(analyst))
      .send({ likelihood: 5, impact: 5, exposure: 5, controlGap: 5 });
    await request(app).post(`/api/assets/${ids.ehrId}/archive`).set(auth(admin));

    expect(await prisma.riskHistory.count({ where: { assetId: ids.ehrId } })).toBe(1);
  });

  it("restores an archived asset", async () => {
    await request(app).post(`/api/assets/${ids.billingId}/archive`).set(auth(admin));
    const res = await request(app).post(`/api/assets/${ids.billingId}/restore`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.archivedAt).toBeNull();
  });

  it("requires ADMIN to archive", async () => {
    expect(
      (await request(app).post(`/api/assets/${ids.billingId}/archive`).set(auth(analyst))).status,
    ).toBe(403);
  });

  it("refuses to archive a vendor that can still reach PHI", async () => {
    const vendor = await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Still Connected" },
    });
    await prisma.vendorAssetAccess.create({
      data: { vendorId: vendor.id, assetId: ids.ehrId },
    });

    const res = await request(app).post(`/api/vendors/${vendor.id}/archive`).set(auth(admin));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("access");
  });

  /**
   * Deactivating a leaver without removing their access is the exact failure
   * this product exists to surface, so the two are one atomic action.
   */
  it("revokes every grant when an identity is archived", async () => {
    const identity = await prisma.identity.create({
      data: { organizationId: ids.organizationId, displayName: "Leaver", kind: "USER" },
    });
    await prisma.accessGrant.createMany({
      data: [
        { organizationId: ids.organizationId, identityId: identity.id, assetId: ids.ehrId },
        { organizationId: ids.organizationId, identityId: identity.id, assetId: ids.billingId },
      ],
    });

    const res = await request(app)
      .post(`/api/identities/${identity.id}/archive`)
      .set(auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.revokedGrants).toBe(2);

    const live = await prisma.accessGrant.count({
      where: { identityId: identity.id, revokedAt: null },
    });
    expect(live).toBe(0);

    // Revoked, not deleted -- the review trail survives.
    expect(await prisma.accessGrant.count({ where: { identityId: identity.id } })).toBe(2);
  });

  it("offers no DELETE on any customer record", async () => {
    const paths = [
      `/api/assets/${ids.ehrId}`,
      `/api/vendors/1`,
      `/api/identities/1`,
      `/api/threats/1`,
      `/api/remediations/1`,
    ];

    for (const path of paths) {
      const res = await request(app).delete(path).set(auth(admin));
      expect(res.status).toBe(404);
    }
  });
});
