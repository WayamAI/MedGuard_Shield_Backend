import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";

/**
 * The policy register's full lifecycle. ROUTE_INVENTORY.md listed these
 * routes as covered by lifecycle.test.ts, which does not in fact touch
 * policies at all — this file closes that gap (policyService.ts sat at
 * 37% line coverage; archivePolicy and setPolicyControl were entirely
 * untested) and corrects the inventory's claim.
 */

const app = createApp();

let ids: Fixture;
let admin: string;
let viewer: string;

beforeEach(async () => {
  ids = await seedFixture();
  admin = await tokenFor(request(app), "admin@test.local");
  viewer = await tokenFor(request(app), "viewer@test.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("policies", () => {
  it("creates, lists, filters by status and search, and reads one back", async () => {
    const created = await request(app)
      .post("/api/policies")
      .set(auth(admin))
      .send({ name: "Acceptable Use Policy", description: "Covers device and data handling", status: "ACTIVE" });
    expect(created.status).toBe(201);

    await request(app)
      .post("/api/policies")
      .set(auth(admin))
      .send({ name: "Draft Retention Policy", description: "Covers data retention", status: "DRAFT" });

    const all = await request(app).get("/api/policies").set(auth(viewer));
    expect(all.body.meta.total).toBe(2);

    const activeOnly = await request(app).get("/api/policies?status=ACTIVE").set(auth(viewer));
    expect(activeOnly.body.data.map((p: { name: string }) => p.name)).toEqual(["Acceptable Use Policy"]);

    const searched = await request(app).get("/api/policies?search=retention").set(auth(viewer));
    expect(searched.body.data.map((p: { name: string }) => p.name)).toEqual(["Draft Retention Policy"]);

    const detail = await request(app).get(`/api/policies/${created.body.data.id}`).set(auth(viewer));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ name: "Acceptable Use Policy", status: "ACTIVE", controls: [] });
  });

  it("404s a policy from another organization", async () => {
    const res = await request(app).get(`/api/policies/999999`).set(auth(viewer));
    expect(res.status).toBe(404);
  });

  it("flags a policy whose review is overdue", async () => {
    const created = await request(app)
      .post("/api/policies")
      .set(auth(admin))
      .send({
        name: "Overdue Policy", description: "Review lapsed",
        reviewDueAt: new Date(Date.now() - 86_400_000).toISOString(),
      });

    const detail = await request(app).get(`/api/policies/${created.body.data.id}`).set(auth(viewer));
    expect(detail.body.data.reviewOverdue).toBe(true);

    const list = await request(app).get("/api/policies").set(auth(viewer));
    expect(list.body.data[0].reviewOverdue).toBe(true);
  });

  it("updates a policy and rejects a duplicate name", async () => {
    const a = await request(app).post("/api/policies").set(auth(admin))
      .send({ name: "Policy A", description: "First" });
    const b = await request(app).post("/api/policies").set(auth(admin))
      .send({ name: "Policy B", description: "Second" });

    const patched = await request(app)
      .patch(`/api/policies/${a.body.data.id}`)
      .set(auth(admin))
      .send({ status: "UNDER_REVIEW" });
    expect(patched.status).toBe(200);
    expect(patched.body.data.status).toBe("UNDER_REVIEW");

    const clash = await request(app)
      .patch(`/api/policies/${b.body.data.id}`)
      .set(auth(admin))
      .send({ name: "Policy A" });
    expect(clash.status).toBe(409);
  });

  it("rejects creating a policy with a name that already exists", async () => {
    await request(app).post("/api/policies").set(auth(admin)).send({ name: "Only One", description: "First" });
    const dup = await request(app).post("/api/policies").set(auth(admin)).send({ name: "Only One", description: "Second" });
    expect(dup.status).toBe(409);
  });

  it("archives a policy, and refuses to archive it twice", async () => {
    const created = await request(app).post("/api/policies").set(auth(admin))
      .send({ name: "Legacy Policy", description: "To retire" });

    const archived = await request(app).post(`/api/policies/${created.body.data.id}/archive`).set(auth(admin));
    expect(archived.status).toBe(200);
    expect(archived.body.data.archivedAt).not.toBeNull();
    expect(archived.body.data.status).toBe("ARCHIVED");

    const again = await request(app).post(`/api/policies/${created.body.data.id}/archive`).set(auth(admin));
    expect(again.status).toBe(409);

    const defaultList = await request(app).get("/api/policies").set(auth(viewer));
    expect(defaultList.body.data).toHaveLength(0);

    const withArchived = await request(app).get("/api/policies?includeArchived=true").set(auth(viewer));
    expect(withArchived.body.data).toHaveLength(1);
  });

  it("links and unlinks a control, both idempotently", async () => {
    const policy = await request(app).post("/api/policies").set(auth(admin))
      .send({ name: "Access Control Policy", description: "Covers access reviews" });
    const control = await request(app).post("/api/controls").set(auth(admin))
      .send({ name: "Quarterly Access Review", description: "Reviews grants", category: "ACCESS", status: "IMPLEMENTED", effectiveness: "EFFECTIVE" });

    const link = await request(app)
      .put(`/api/policies/${policy.body.data.id}/controls/${control.body.data.id}`)
      .set(auth(admin));
    expect(link.status).toBe(200);
    expect(link.body.data).toEqual({ policyId: policy.body.data.id, controlId: control.body.data.id, linked: true });

    // Idempotent: linking again does not error or duplicate.
    await request(app).put(`/api/policies/${policy.body.data.id}/controls/${control.body.data.id}`).set(auth(admin));

    const detail = await request(app).get(`/api/policies/${policy.body.data.id}`).set(auth(viewer));
    expect(detail.body.data.controls).toHaveLength(1);
    expect(detail.body.data.controls[0]).toMatchObject({ name: "Quarterly Access Review" });

    const unlink = await request(app)
      .delete(`/api/policies/${policy.body.data.id}/controls/${control.body.data.id}`)
      .set(auth(admin));
    expect(unlink.status).toBe(200);
    expect(unlink.body.data.linked).toBe(false);

    const afterUnlink = await request(app).get(`/api/policies/${policy.body.data.id}`).set(auth(viewer));
    expect(afterUnlink.body.data.controls).toHaveLength(0);

    // Idempotent in the other direction too: unlinking twice does not error.
    const unlinkAgain = await request(app)
      .delete(`/api/policies/${policy.body.data.id}/controls/${control.body.data.id}`)
      .set(auth(admin));
    expect(unlinkAgain.status).toBe(200);
  });

  it("404s linking a control that belongs to another organization", async () => {
    const policy = await request(app).post("/api/policies").set(auth(admin))
      .send({ name: "Isolated Policy", description: "Tenant check" });

    const rivalControl = await prisma.control.create({
      data: { organizationId: ids.otherOrganizationId, name: "Rival Control", description: "x", category: "ACCESS", status: "IMPLEMENTED", effectiveness: "EFFECTIVE" },
    });

    const res = await request(app)
      .put(`/api/policies/${policy.body.data.id}/controls/${rivalControl.id}`)
      .set(auth(admin));
    expect(res.status).toBe(404);
  });

  it("is audited: create, update, archive and link/unlink each record a history entry", async () => {
    const policy = await request(app).post("/api/policies").set(auth(admin))
      .send({ name: "Audited Policy", description: "Covers audit trail" });
    await request(app).patch(`/api/policies/${policy.body.data.id}`).set(auth(admin)).send({ status: "ACTIVE" });

    const control = await request(app).post("/api/controls").set(auth(admin))
      .send({ name: "Audit Control", description: "x", category: "ACCESS", status: "IMPLEMENTED", effectiveness: "EFFECTIVE" });
    await request(app).put(`/api/policies/${policy.body.data.id}/controls/${control.body.data.id}`).set(auth(admin));
    await request(app).delete(`/api/policies/${policy.body.data.id}/controls/${control.body.data.id}`).set(auth(admin));
    await request(app).post(`/api/policies/${policy.body.data.id}/archive`).set(auth(admin));

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "Policy", entityId: policy.body.data.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual([
      "POLICY_CREATED", "POLICY_UPDATED", "POLICY_UPDATED", "POLICY_UPDATED", "POLICY_ARCHIVED",
    ]);
  });
});
