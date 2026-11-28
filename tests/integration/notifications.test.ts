import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { runNotificationSweep } from "../../src/services/notificationService.js";
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

const asAdmin = (path: string) => request(app).get(path).set("Authorization", `Bearer ${adminToken}`);

describe("notification sweep", () => {
  it("creates a notification for an overdue remediation", async () => {
    await prisma.remediation.create({
      data: {
        organizationId: ids.organizationId, title: "Fix it", description: "d", recommendation: "r",
        status: "OPEN", dueAt: new Date(Date.now() - 86_400_000),
      },
    });
    const { created } = await runNotificationSweep(ids.organizationId);
    expect(created).toBeGreaterThanOrEqual(1);

    const list = await asAdmin("/api/notifications");
    expect(list.body.data.some((n: { type: string }) => n.type === "REMEDIATION_OVERDUE")).toBe(true);
  });

  it("creates a notification for a vendor with an invalid BAA", async () => {
    await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Bad Vendor", baaStatus: "EXPIRED" },
    });
    await runNotificationSweep(ids.organizationId);
    const list = await asAdmin("/api/notifications");
    expect(list.body.data.some((n: { type: string }) => n.type === "VENDOR_BAA_INVALID")).toBe(true);
  });

  it("creates a notification for an overdue policy review", async () => {
    await prisma.policy.create({
      data: {
        organizationId: ids.organizationId, name: "Old Policy", description: "d", status: "UNDER_REVIEW",
        reviewDueAt: new Date(Date.now() - 86_400_000),
      },
    });
    await runNotificationSweep(ids.organizationId);
    const list = await asAdmin("/api/notifications");
    expect(list.body.data.some((n: { type: string }) => n.type === "POLICY_REVIEW_OVERDUE")).toBe(true);
  });

  it("creates exactly one notification per condition, even run twice", async () => {
    await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Dup Vendor", baaStatus: "MISSING" },
    });
    const first = await runNotificationSweep(ids.organizationId);
    const second = await runNotificationSweep(ids.organizationId);
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);

    const count = await prisma.notification.count({
      where: { organizationId: ids.organizationId, entityType: "Vendor" },
    });
    expect(count).toBe(first.created);
  });

  it("notifies immediately on a new HIGH/CRITICAL threat, not on LOW/MEDIUM", async () => {
    const high = await request(app)
      .post("/api/threats")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assetId: ids.ehrId, severity: "HIGH", title: "Bad thing", description: "d" });
    expect(high.status).toBe(201);

    const low = await request(app)
      .post("/api/threats")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assetId: ids.ehrId, severity: "LOW", title: "Minor thing", description: "d" });
    expect(low.status).toBe(201);

    const list = await asAdmin("/api/notifications");
    const threatNotifs = list.body.data.filter((n: { type: string }) => n.type === "THREAT_NEW_HIGH_SEVERITY");
    expect(threatNotifs).toHaveLength(1);
    expect(threatNotifs[0].title).toContain("Bad thing");
  });
});

describe("read state", () => {
  it("marks one notification read, per-user", async () => {
    await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Unread Vendor", baaStatus: "MISSING" },
    });
    await runNotificationSweep(ids.organizationId);
    const before = await asAdmin("/api/notifications/unread-count");
    expect(before.body.data.count).toBeGreaterThan(0);

    const list = await asAdmin("/api/notifications");
    const id = list.body.data[0].id;
    await request(app).post(`/api/notifications/${id}/read`).set("Authorization", `Bearer ${adminToken}`);

    const after = await asAdmin("/api/notifications/unread-count");
    expect(after.body.data.count).toBe(before.body.data.count - 1);
  });

  it("mark-all-read clears the unread count", async () => {
    await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Vendor A", baaStatus: "MISSING" },
    });
    await prisma.vendor.create({
      data: { organizationId: ids.organizationId, name: "Vendor B", baaStatus: "EXPIRED" },
    });
    await runNotificationSweep(ids.organizationId);

    await request(app).post("/api/notifications/read-all").set("Authorization", `Bearer ${adminToken}`);
    const after = await asAdmin("/api/notifications/unread-count");
    expect(after.body.data.count).toBe(0);
  });
});
