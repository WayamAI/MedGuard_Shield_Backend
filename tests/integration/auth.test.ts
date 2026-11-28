import { createRequire } from "node:module";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, TEST_PASSWORD, tokenFor } from "../helpers.js";

const app = createApp();

beforeAll(async () => {
  await seedFixture();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /health", () => {
  it("is public and reports ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "drishti-api" });
  });

  /**
   * Regression: the version used to come from process.env.npm_package_version,
   * which npm sets only for a process it spawned. The container runs
   * `node dist/server.js` directly, so in production the variable was absent
   * and /health served a stale hardcoded fallback instead.
   *
   * Compared against package.json rather than a literal, so a release bump
   * does not have to remember this test.
   */
  it("reports the version from package.json, not a hardcoded fallback", async () => {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version: string };
    const res = await request(app).get("/health");
    expect(res.body.version).toBe(pkg.version);
  });
});

describe("POST /api/auth/login", () => {
  it("returns a token, expiry, and the user on valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
    expect(res.body.data.expiresIn).toBe(3600);
    expect(res.body.data.user).toMatchObject({ email: "admin@test.local", role: "ADMIN" });
  });

  it("sets only the refresh token as an httpOnly cookie, never the access token", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: TEST_PASSWORD });

    const cookies = (res.headers["set-cookie"] ?? []) as unknown as string[];
    const joined = cookies.join("; ");
    expect(joined).toContain("drishti_refresh=");
    expect(joined).not.toContain("drishti_token=");
    expect(cookies.every((c) => c.includes("HttpOnly"))).toBe(true);
  });

  it("rejects a wrong password with 401", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("gives an unknown address the identical error, so accounts cannot be enumerated", async () => {
    const unknown = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@test.local", password: TEST_PASSWORD });
    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: "wrong" });

    expect(unknown.status).toBe(wrongPassword.status);
    // requestId is unique per request by design (see middleware/logging.ts)
    // and carries no information about which branch produced the error, so
    // it's excluded from the enumeration-safety comparison.
    const { requestId: _unknownId, ...unknownError } = unknown.body.error;
    const { requestId: _wrongId, ...wrongPasswordError } = wrongPassword.body.error;
    expect(unknownError).toEqual(wrongPasswordError);
  });

  it("rejects a malformed body with 400 and names the bad fields", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email", password: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      "email",
      "password",
    ]);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the caller's identity with a valid token", async () => {
    const token = await tokenFor(request(app), "analyst@test.local");
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: "analyst@test.local", role: "ANALYST" });
  });

  /**
   * Regression for a CSRF bug: a cookie is sent automatically on a cross-site
   * request, with no way to require a custom header the way refresh/logout
   * do. The access token must work only via the header an attacker's page
   * cannot set on a cross-site request.
   */
  it("does not accept a forged access-token cookie as authentication", async () => {
    const token = await tokenFor(request(app), "admin@test.local");

    const res = await request(app).get("/api/auth/me").set("Cookie", `drishti_token=${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects a missing token with 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Authentication required");
  });
});

describe("POST /api/auth/logout", () => {
  it("succeeds and clears the cookie", async () => {
    const res = await request(app).post("/api/auth/logout").set("X-Drishti-Csrf", "1");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
    expect(res.headers["set-cookie"]?.[0] ?? "").toContain("drishti_token=;");
  });
  /**
   * Logout has no genuine failure path: it is public, and clearing a cookie
   * that is not there is not an error. These two pin that down as intended
   * behaviour rather than an accident of routing.
   */
  it("is callable without a session, since a logged-out client still has a cookie to clear", async () => {
    const res = await request(app).post("/api/auth/logout").set("X-Drishti-Csrf", "1");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
  });

  it("is idempotent — calling it twice is not an error", async () => {
    await request(app).post("/api/auth/logout").set("X-Drishti-Csrf", "1");
    expect((await request(app).post("/api/auth/logout").set("X-Drishti-Csrf", "1")).status).toBe(200);
  });

});
