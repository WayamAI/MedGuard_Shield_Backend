import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor } from "../helpers.js";
import { STALE_AFTER_DAYS } from "../../src/services/accessService.js";

const app = createApp();
const DAY = 86_400_000;
let token: string;
let ids: Awaited<ReturnType<typeof seedFixture>>;

const ago = (d: number) => new Date(Date.now() - d * DAY);

beforeEach(async () => {
  ids = await seedFixture();
  token = await tokenFor(request(app), "admin@test.local");

  // Four identities, each isolating one flag so assertions cannot pass by
  // accident: a clean grant, a stale one, a never-used one, and a departed
  // identity holding write access to the high-volume asset.
  const clean = await prisma.identity.create({
    data: { displayName: "Clean User", email: "clean@test.local", kind: "USER", active: true, mfaEnabled: true },
  });
  const stale = await prisma.identity.create({
    data: { displayName: "Stale User", email: "stale@test.local", kind: "USER", active: true, mfaEnabled: true },
  });
  const svc = await prisma.identity.create({
    data: { displayName: "svc-never-used", email: null, kind: "SERVICE_ACCOUNT", active: true, mfaEnabled: false },
  });
  const departed = await prisma.identity.create({
    data: { displayName: "Departed", email: "gone@test.local", kind: "USER", active: false, mfaEnabled: false },
  });

  // Test EHR has phiVolume 1000, below the EXCESSIVE_LEVEL threshold, so
  // raise it for the departed identity's grant to trip that flag.
  await prisma.asset.update({ where: { id: ids.ehrId }, data: { phiVolume: 100_000 } });

  await prisma.accessGrant.createMany({
    data: [
      { identityId: clean.id, assetId: ids.billingId, level: "READ", grantedAt: ago(100), lastUsedAt: ago(1) },
      { identityId: stale.id, assetId: ids.billingId, level: "READ", grantedAt: ago(300), lastUsedAt: ago(200) },
      { identityId: svc.id, assetId: ids.billingId, level: "READ", grantedAt: ago(400), lastUsedAt: null },
      { identityId: departed.id, assetId: ids.ehrId, level: "ADMIN", grantedAt: ago(500), lastUsedAt: ago(250) },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const get = () => request(app).get("/api/access").set("Authorization", `Bearer ${token}`);
const byName = (rows: any[], name: string) => rows.find((r) => r.identityName === name);

describe("GET /api/access", () => {
  it("requires authentication", async () => {
    expect((await request(app).get("/api/access")).status).toBe(401);
  });

  it("returns every grant with a summary", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.grants).toHaveLength(4);
    expect(res.body.data.summary).toMatchObject({
      total: 4,
      stale: 2,
      neverUsed: 1,
      inactiveIdentities: 1,
      staleAfterDays: STALE_AFTER_DAYS,
    });
  });

  it("leaves a healthy grant unflagged", async () => {
    const row = byName((await get()).body.data.grants, "Clean User");
    expect(row.flags).toEqual([]);
    expect(row.daysSinceUse).toBe(1);
  });

  it("flags a grant unused beyond the stale threshold", async () => {
    const row = byName((await get()).body.data.grants, "Stale User");
    expect(row.flags).toContain("STALE");
    expect(row.daysSinceUse).toBe(200);
  });

  it("distinguishes never-used from merely stale", async () => {
    const row = byName((await get()).body.data.grants, "svc-never-used");
    expect(row.flags).toContain("NEVER_USED");
    expect(row.flags).not.toContain("STALE");
    expect(row.daysSinceUse).toBeNull();
  });

  it("does not demand MFA of service accounts", async () => {
    const row = byName((await get()).body.data.grants, "svc-never-used");
    expect(row.flags).not.toContain("NO_MFA");
  });

  it("accumulates every applicable flag on the worst grant", async () => {
    const row = byName((await get()).body.data.grants, "Departed");
    expect(row.flags.sort()).toEqual(
      ["EXCESSIVE_LEVEL", "INACTIVE_IDENTITY", "NO_MFA", "STALE"].sort(),
    );
  });

  it("orders worst-first so a reviewer starts where it matters", async () => {
    const rows = (await get()).body.data.grants;
    expect(rows[0].identityName).toBe("Departed");
    expect(rows[rows.length - 1].identityName).toBe("Clean User");
  });

  it("treats a grant used exactly at the threshold as not yet stale", async () => {
    await prisma.accessGrant.updateMany({
      where: { level: "READ" },
      data: { lastUsedAt: ago(STALE_AFTER_DAYS) },
    });
    const rows = (await get()).body.data.grants;
    for (const r of rows.filter((x: any) => x.level === "READ" && x.daysSinceUse !== null)) {
      expect(r.flags).not.toContain("STALE");
    }
  });

  it("is readable by VIEWER", async () => {
    const viewer = await tokenFor(request(app), "viewer@test.local");
    const res = await request(app).get("/api/access").set("Authorization", `Bearer ${viewer}`);
    expect(res.status).toBe(200);
  });
});
