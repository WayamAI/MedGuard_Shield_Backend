import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, sessionFor, type Fixture } from "../helpers.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "../../src/services/authService.js";

/**
 * Refresh-token rotation and revocation.
 *
 * The access token is deliberately short-lived and cannot be revoked; the
 * refresh token is long-lived and can. These tests pin the properties that
 * make that trade sound.
 */

const app = createApp();

let ids: Fixture;

beforeEach(async () => {
  ids = await seedFixture();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const login = () => sessionFor(request(app), "admin@test.local");

describe("POST /api/auth/login", () => {
  it("issues a short-lived access token and a refresh token", async () => {
    const session = await login();
    expect(session.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(session.refreshToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets both tokens as httpOnly cookies", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: "test-password" });

    const cookies = (res.headers["set-cookie"] ?? []) as unknown as string[];
    const joined = cookies.join("; ");
    expect(joined).toContain("drishti_token=");
    expect(joined).toContain("drishti_refresh=");
    expect(cookies.every((c) => c.includes("HttpOnly"))).toBe(true);
  });

  /**
   * The stored value must not be usable as a session. If the column held the
   * token itself, a database read would hand over every live login.
   */
  it("stores the refresh token only as a hash", async () => {
    const session = await login();
    const stored = await prisma.refreshToken.findMany();

    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(session.refreshToken);
    expect(stored[0]!.tokenHash).toHaveLength(64);
  });

  it("reports every organization the account belongs to", async () => {
    const session = await login();
    expect(session.user.organizationId).toBe(ids.organizationId);
  });
});

describe("POST /api/auth/refresh", () => {
  it("exchanges a refresh token for a new pair", async () => {
    const first = await login();

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTypeOf("string");
    expect(res.body.data.refreshToken).not.toBe(first.refreshToken);
  });

  it("revokes the presented token as part of the exchange", async () => {
    const first = await login();
    await request(app).post("/api/auth/refresh").send({ refreshToken: first.refreshToken });

    const rows = await prisma.refreshToken.findMany({ orderBy: { id: "asc" } });
    expect(rows[0]!.revokedAt).not.toBeNull();
    expect(rows[0]!.replacedByTokenHash).not.toBeNull();
    expect(rows[1]!.revokedAt).toBeNull();
  });

  it("returns a working access token", async () => {
    const first = await login();
    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken });

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${refreshed.body.data.token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.organizationId).toBe(ids.organizationId);
  });

  /**
   * Replay means the chain is compromised: either a copy was stolen, or the
   * legitimate holder is racing a thief. Rejecting only the replayed token
   * would leave the thief's rotated copy working, so every live token for that
   * user is revoked instead.
   */
  it("revokes every session when an already-rotated token is presented again", async () => {
    const first = await login();
    const second = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken });

    const replay = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken });

    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toContain("already been used");

    // The token issued by the legitimate refresh is dead too.
    const afterReplay = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: second.body.data.refreshToken });
    expect(afterReplay.status).toBe(401);

    const live = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it("401s an unknown refresh token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "f".repeat(64) });
    expect(res.status).toBe(401);
  });

  it("401s an expired refresh token", async () => {
    const session = await login();
    await prisma.refreshToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: session.refreshToken });
    expect(res.status).toBe(401);
  });

  /**
   * A refresh token is not standing proof of access. Membership is re-read on
   * every exchange, so access withdrawn between logins takes effect at the
   * next refresh rather than at the next login.
   */
  it("refuses to refresh once membership has been withdrawn", async () => {
    const session = await login();
    await prisma.organizationMember.deleteMany({
      where: { userId: session.user.id, organizationId: ids.organizationId },
    });

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: session.refreshToken });

    expect(res.status).toBe(403);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });
});

describe("logout", () => {
  it("revokes the refresh token so it cannot be exchanged again", async () => {
    const session = await login();

    const out = await request(app)
      .post("/api/auth/logout")
      .send({ refreshToken: session.refreshToken });
    expect(out.status).toBe(200);

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: session.refreshToken });
    expect(res.status).toBe(401);
  });

  it("clears both cookies", async () => {
    const res = await request(app).post("/api/auth/logout");
    const cookies = ((res.headers["set-cookie"] ?? []) as unknown as string[]).join("; ");
    expect(cookies).toContain("drishti_token=;");
    expect(cookies).toContain("drishti_refresh=;");
  });

  it("logout-all revokes every live session for the account", async () => {
    const a = await login();
    const b = await login();
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(2);

    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${a.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.revokedSessions).toBe(2);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);

    for (const session of [a, b]) {
      const attempt = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: session.refreshToken });
      expect(attempt.status).toBe(401);
    }
  });
});

describe("the legacy cookie still authenticates", () => {
  /**
   * A browser holding a MedGuard-era session must not be silently logged out
   * by the rename. The old name is accepted on the way in and never set.
   */
  it("accepts medguard_token for an otherwise valid access token", async () => {
    const session = await login();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `medguard_token=${session.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("admin@test.local");
  });
});
