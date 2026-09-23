import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, TEST_PASSWORD } from "../helpers.js";

// A fresh app per describe block: rate-limit state lives in the limiter
// instance, so sharing one app would let one block exhaust another's budget.
beforeAll(async () => {
  await seedFixture();
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

  it("advertises the limit on ordinary responses", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["ratelimit-policy"]).toMatch(/w=900/);
    expect(res.headers["ratelimit"]).toMatch(/limit=\d+, remaining=\d+/);
  });
});
