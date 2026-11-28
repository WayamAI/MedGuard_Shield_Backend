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

describe("audit trail immutability", () => {
  it("a raw SQL UPDATE on AuditEvent fails", async () => {
    const row = await prisma.auditEvent.findFirst({ where: { organizationId: ids.organizationId } });
    expect(row).not.toBeNull();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "actorEmail" = 'hacked' WHERE id = $1`, row!.id),
    ).rejects.toThrow(/append-only/);
  });

  it("a raw SQL DELETE on AuditEvent fails", async () => {
    const row = await prisma.auditEvent.findFirst({ where: { organizationId: ids.organizationId } });
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE id = $1`, row!.id)).rejects.toThrow(
      /append-only/,
    );
  });

  it("a raw SQL DELETE fails even for an organization whose slug contains 'demo'", async () => {
    // The exception is keyed on the *database* name, not any row's content —
    // this proves an org named/slugged like a demo tenant gets no special
    // treatment on a real database.
    const org = await prisma.organization.create({ data: { name: "Demographics Health", slug: "demographics-health-demo" } });
    const audit = await prisma.auditEvent.create({
      data: { organizationId: org.id, action: "LOGIN", actorEmail: "x@example.com" },
    });
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE id = $1`, audit.id)).rejects.toThrow(
      /append-only/,
    );
  });

  it("no route can modify or remove an audit row either", async () => {
    // There is deliberately no PATCH/PUT/DELETE route under /api/audit; confirm the surface really is read-only.
    const row = await prisma.auditEvent.findFirst({ where: { organizationId: ids.organizationId } });
    for (const method of ["patch", "put", "delete"] as const) {
      const res = await request(app)[method](`/api/audit/${row!.id}`).set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    }
  });
});

describe("GET /api/audit/verify", () => {
  it("reports the chain intact after ordinary activity", async () => {
    await request(app).post("/api/assets").set("Authorization", `Bearer ${adminToken}`).send({ name: "New Asset", type: "API" });
    const res = await request(app).get("/api/audit/verify").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ intact: true, firstBrokenId: null });
    expect(res.body.data.checked).toBeGreaterThan(0);
  });

  it("detects a tampered row — the first broken entry is named", async () => {
    const rows = await prisma.auditEvent.findMany({ where: { organizationId: ids.organizationId }, orderBy: { id: "asc" } });
    const target = rows[Math.floor(rows.length / 2)]!;

    // Simulate tampering below the trigger (as if a superuser rewrote the row directly).
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_no_update`);
    await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "actorEmail" = 'tampered' WHERE id = $1`, target.id);
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_event_no_update`);

    const res = await request(app).get("/api/audit/verify").set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.data.intact).toBe(false);
    expect(res.body.data.firstBrokenId).toBe(target.id);
  });

  it("is admin-only", async () => {
    const res = await request(app).get("/api/audit/verify").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });
});
