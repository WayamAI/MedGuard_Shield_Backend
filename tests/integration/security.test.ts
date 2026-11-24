import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createAuthenticatedLimiter } from "../../src/middleware/security.js";
import { prisma } from "../../src/lib/prisma.js";
import { hashPassword } from "../../src/services/authService.js";
import type { Fixture } from "../helpers.js";
import { seedFixture, TEST_PASSWORD, tokenFor } from "../helpers.js";

let fixture: Fixture;

// A fresh app per describe block: rate-limit state lives in the limiter
// instance, so sharing one app would let one block exhaust another's budget.
beforeAll(async () => {
  fixture = await seedFixture();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("security headers", () => {
  const app = createApp();

  it("sets helmet's headers on a successful response", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("removes the header that advertises Express", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("still sets them on an error response", async () => {
    const res = await request(app).get("/api/assets");
    expect(res.status).toBe(401);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("leaves CSP off, since this process serves only JSON", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("login rate limiting", () => {
  const app = createApp();

  it("rejects the 6th failed attempt with 429 and a structured body", async () => {
    const attempt = () =>
      request(app)
        .post("/api/auth/login")
        .send({ email: "admin@test.local", password: "wrong" });

    // Test limit is 5 failures per window.
    for (let i = 0; i < 5; i++) {
      expect((await attempt()).status).toBe(401);
    }

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    // draft-7 emits a single combined header, not RateLimit-Limit.
    expect(blocked.headers["ratelimit"]).toMatch(/limit=5/);

    /*
     * Retry-After is part of the contract, not an incidental header. The
     * frontend keeps a signed-in user signed in through a 429 and schedules
     * its next refresh from this value; without it the client can only guess
     * how long to wait.
     */
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("keeps blocking even when the correct password is then offered", async () => {
    // The budget is already spent by the previous test on this app instance.
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: TEST_PASSWORD });
    expect(res.status).toBe(429);
  });
});

describe("successful logins do not consume the login budget", () => {
  const app = createApp();

  it("allows more successful logins than the failure limit", async () => {
    // skipSuccessfulRequests means a legitimate user is never locked out.
    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "admin@test.local", password: TEST_PASSWORD });
      expect(res.status).toBe(200);
    }
  });
});

describe("global rate limiting", () => {
  const app = createApp();

  it("advertises the backstop limit on /api/auth", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "nobody@test.local", password: "x" });
    expect(res.headers["ratelimit-policy"]).toMatch(/w=900/);
    expect(res.headers["ratelimit"]).toMatch(/limit=\d+, remaining=\d+/);
  });

  it("advertises the per-user authenticated limit on ordinary API responses", async () => {
    const token = await tokenFor(request(app), "admin@test.local");
    const res = await request(app).get("/api/assets").set("Authorization", `Bearer ${token}`);
    expect(res.headers["ratelimit-policy"]).toMatch(/w=900/);
    expect(res.headers["ratelimit"]).toMatch(/limit=\d+, remaining=\d+/);
  });
});

describe("the authenticated rate limiter is keyed per user, not per IP", () => {
  const app = createApp();

  /**
   * Regression for the shared-NAT bug: under the old IP-keyed global
   * limiter (limit 1000 in test mode), 50 users behind one IP sending 25
   * requests each — 1250 total, all from the same test-harness "IP" —
   * would have started 429ing partway through. Keyed per user, every one
   * of them gets their own budget, so all 1250 succeed.
   */
  it("50 users behind one IP aren't throttled in normal use", async () => {
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const users = await prisma.user.createManyAndReturn({
      data: Array.from({ length: 50 }, (_, i) => ({
        email: `shared-nat-${i}@test.local`,
        role: "VIEWER" as const,
        passwordHash,
      })),
    });
    await prisma.organizationMember.createMany({
      data: users.map((u) => ({ userId: u.id, organizationId: fixture.organizationId, role: "VIEWER" as const })),
    });

    // Sequential, not Promise.all: express-rate-limit's skipSuccessfulRequests
    // increments before a response is known and only backs the count out
    // afterward on success, so 50 logins landing in the same instant would
    // race the login limiter's own counter — a test artifact, not something
    // real concurrent users would ever actually do at the same millisecond.
    const tokens: string[] = [];
    for (const u of users) tokens.push(await tokenFor(request(app), u.email));

    const results = await Promise.all(
      tokens.flatMap((token) =>
        Array.from({ length: 25 }, () => request(app).get("/api/assets").set("Authorization", `Bearer ${token}`)),
      ),
    );

    const bad = results.filter((r) => r.status !== 200);
    expect(bad.map((r) => [r.status, r.body]), "all 1250 requests should 200").toEqual([]);
  }, 30_000); // 50 sequential bcrypt logins comfortably exceed the default 5s test budget

  /** A single user's own budget still runs out — the point was never "no limit". */
  it("one user flooding is throttled", async () => {
    const limitedApp = express();
    limitedApp.use((req, _res, next) => {
      req.ctx = { userId: fixture.adminUserId, email: "admin@test.local", role: "ADMIN", organizationId: fixture.organizationId };
      next();
    });
    limitedApp.use(createAuthenticatedLimiter({ limit: 5 }));
    limitedApp.get("/ping", (_req, res) => res.json({ ok: true }));

    const results = await Promise.all(Array.from({ length: 8 }, () => request(limitedApp).get("/ping")));

    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
  });

  /**
   * Covered more fully by the "login rate limiting" block above, restated
   * here because it's the one thing this redesign must not have weakened:
   * createLoginLimiter stays IP-keyed, unaffected by any of the above.
   */
  it("login brute force from one IP is still throttled", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/auth/login").send({ email: "admin@test.local", password: "wrong" });
    }
    const res = await request(app).post("/api/auth/login").send({ email: "admin@test.local", password: "wrong" });
    expect(res.status).toBe(429);
  });
});

describe("CORS", () => {
  const app = createApp();

  it("allows the configured FRONTEND_ORIGIN with credentials", async () => {
    const res = await request(app).options("/api/assets").set("Origin", "http://localhost:8080").set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not reflect an arbitrary origin — no wildcard, no echo", async () => {
    const res = await request(app).options("/api/assets").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("a cross-origin GET from an unapproved origin carries no CORS headers permitting it to be read", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
