import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";
import { diffFields, sanitiseMetadata } from "../../src/services/auditService.js";

/**
 * The audit trail.
 *
 * Two properties matter here and are tested separately: that actions are
 * recorded at all, and that what is recorded never contains a credential or a
 * patient identifier.
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

const eventsFor = (action: string) =>
  prisma.auditEvent.findMany({ where: { action: action as never }, orderBy: { id: "asc" } });

describe("authentication events", () => {
  it("records a successful login with the actor", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: "test-password" });

    const [event] = await eventsFor("LOGIN");
    expect(event).toBeDefined();
    expect(event!.actorEmail).toBe("admin@test.local");
    expect(event!.result).toBe("SUCCESS");
    expect(event!.organizationId).toBe(ids.organizationId);
  });

  /**
   * The event a security review actually asks for. It has no verified actor by
   * definition, so the attempted address is stored as an attempt rather than
   * as an assertion that the account exists.
   */
  it("records a failed login without confirming the account exists", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@test.local", password: "wrong" });

    const [event] = await eventsFor("LOGIN_FAILED");
    expect(event).toBeDefined();
    expect(event!.result).toBe("FAILURE");
    expect(event!.actorEmail).toBe("nobody@test.local");
    expect(event!.actorUserId).toBeNull();
  });

  it("never stores the submitted password", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: "hunter2-should-not-appear" });

    const all = await prisma.auditEvent.findMany();
    const serialised = JSON.stringify(all);
    expect(serialised).not.toContain("hunter2-should-not-appear");
  });
});

describe("data mutations are recorded", () => {
  it("records an asset creation with its identity", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${admin}`)
      .send({ name: "Audited Asset", type: "API" });

    const [event] = await eventsFor("ASSET_CREATED");
    expect(event!.entityType).toBe("Asset");
    expect(event!.entityId).toBe(res.body.data.id);
    expect(event!.metadata).toMatchObject({ name: "Audited Asset", type: "API" });
  });

  it("records before and after values on an update", async () => {
    await request(app)
      .patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${analyst}`)
      .send({ phiVolume: 7777 });

    const [event] = await eventsFor("ASSET_UPDATED");
    expect(event!.metadata).toMatchObject({
      changes: { phiVolume: { from: 1000, to: 7777 } },
    });
  });

  it("records a threat status transition with both statuses", async () => {
    const threat = await prisma.threat.create({
      data: {
        organizationId: ids.organizationId, assetId: ids.ehrId,
        severity: "HIGH", title: "Audited threat", description: "d",
      },
    });

    await request(app)
      .post(`/api/threats/${threat.id}/status`)
      .set("Authorization", `Bearer ${analyst}`)
      .send({ status: "INVESTIGATING" });

    const [event] = await eventsFor("THREAT_STATUS_CHANGED");
    expect(event!.metadata).toMatchObject({ from: "OPEN", to: "INVESTIGATING" });
  });

  it("records an access revocation", async () => {
    const identity = await prisma.identity.create({
      data: { organizationId: ids.organizationId, displayName: "Audited Person", kind: "USER" },
    });
    const grant = await prisma.accessGrant.create({
      data: { organizationId: ids.organizationId, identityId: identity.id, assetId: ids.ehrId },
    });

    await request(app)
      .post(`/api/access/${grant.id}/revoke`)
      .set("Authorization", `Bearer ${analyst}`);

    const [event] = await eventsFor("ACCESS_REVOKED");
    expect(event!.entityId).toBe(grant.id);
  });

  it("records both the start and the completion of an import", async () => {
    const csv = "name,type,phiVolume\nImported Asset,API,5\n";
    await request(app)
      .post("/api/import/assets")
      .set("Authorization", `Bearer ${admin}`)
      .attach("file", Buffer.from(csv), "assets.csv");

    expect(await eventsFor("IMPORT_STARTED")).toHaveLength(1);
    const [done] = await eventsFor("IMPORT_COMPLETED");
    expect(done!.metadata).toMatchObject({ entity: "assets", imported: 1 });
  });

  it("records a failed import as a failure", async () => {
    const csv = "name,type\nBad Asset,MAINFRAME\n";
    await request(app)
      .post("/api/import/assets")
      .set("Authorization", `Bearer ${admin}`)
      .attach("file", Buffer.from(csv), "assets.csv");

    const [failed] = await eventsFor("IMPORT_FAILED");
    expect(failed!.result).toBe("FAILURE");
  });

  /**
   * An audited write and its audit row share a transaction, so a rolled-back
   * change cannot leave a record saying it happened.
   */
  it("writes no audit row when the write itself is refused", async () => {
    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", `Bearer ${viewer}`)
      .send({ name: "Refused", type: "API" });

    expect(res.status).toBe(403);
    expect(await eventsFor("ASSET_CREATED")).toHaveLength(0);
  });
});

describe("GET /api/audit", () => {
  it("is ADMIN only", async () => {
    expect(
      (await request(app).get("/api/audit").set("Authorization", `Bearer ${analyst}`)).status,
    ).toBe(403);
    expect(
      (await request(app).get("/api/audit").set("Authorization", `Bearer ${viewer}`)).status,
    ).toBe(403);
  });

  it("returns events newest first, paginated", async () => {
    for (const name of ["A1", "A2", "A3"]) {
      await request(app).post("/api/assets").set("Authorization", `Bearer ${admin}`)
        .send({ name, type: "API" });
    }

    const res = await request(app)
      .get("/api/audit?action=ASSET_CREATED&pageSize=2")
      .set("Authorization", `Bearer ${admin}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(res.body.data[0].metadata.name).toBe("A3");
  });

  it("filters to one entity for a detail page's history tab", async () => {
    await request(app).patch(`/api/assets/${ids.ehrId}`)
      .set("Authorization", `Bearer ${admin}`).send({ phiVolume: 1 });

    const res = await request(app)
      .get(`/api/assets/${ids.ehrId}/history`)
      .set("Authorization", `Bearer ${admin}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].action).toBe("ASSET_UPDATED");
  });

  it("offers no write path at all", async () => {
    for (const method of ["post", "patch", "delete"] as const) {
      const res = await request(app)[method]("/api/audit")
        .set("Authorization", `Bearer ${admin}`)
        .send({ action: "LOGIN" });
      expect(res.status).toBe(404);
    }
  });
});

describe("metadata sanitisation", () => {
  it("redacts anything that looks like a credential", () => {
    const out = sanitiseMetadata({
      name: "fine",
      password: "secret",
      passwordHash: "$2b$10$abc",
      apiKey: "sk-live-123",
      authorization: "Bearer xyz",
    }) as Record<string, unknown>;

    expect(out.name).toBe("fine");
    for (const key of ["password", "passwordHash", "apiKey", "authorization"]) {
      expect(out[key]).toBe("[redacted]");
    }
  });

  it("redacts patient identifiers rather than storing PHI in the trail", () => {
    const out = sanitiseMetadata({ mrn: "123456", ssn: "000-00-0000", patientName: "Jane Roe" }) as
      Record<string, unknown>;

    expect(out.mrn).toBe("[redacted]");
    expect(out.ssn).toBe("[redacted]");
    expect(out.patientName).toBe("[redacted]");
  });

  it("truncates long strings so one field cannot flood the table", () => {
    const out = sanitiseMetadata({ note: "x".repeat(5000) }) as { note?: string };
    expect(out.note).toBeDefined();
    expect(out.note!.length).toBeLessThanOrEqual(501);
  });

  it("returns undefined rather than an empty object", () => {
    expect(sanitiseMetadata({})).toBeUndefined();
    expect(sanitiseMetadata(null)).toBeUndefined();
  });
});

describe("diffFields", () => {
  it("reports only what changed", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ b: { from: 2, to: 3 } });
  });

  it("ignores fields absent from the update", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1 })).toBeUndefined();
  });

  it("compares dates by value, not by identity", () => {
    const d = new Date("2026-01-01");
    expect(diffFields({ at: d }, { at: new Date("2026-01-01") })).toBeUndefined();
    expect(diffFields({ at: d }, { at: new Date("2026-02-01") })).not.toBeUndefined();
  });
});
