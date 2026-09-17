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
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /api/auth/login", () => {
  it("returns a token, expiry, and the user on valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
    expect(res.body.data.expiresIn).toBe(28800);
    expect(res.body.data.user).toMatchObject({ email: "admin@test.local", role: "ADMIN" });
  });

  it("sets an httpOnly session cookie alongside the token", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: TEST_PASSWORD });

    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("medguard_token=");
    expect(cookie).toContain("HttpOnly");
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
    expect(unknown.body).toEqual(wrongPassword.body);
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

  it("accepts the session cookie as well as a bearer header", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@test.local", password: TEST_PASSWORD });

    // set-cookie is an array; supertest needs a single header value.
    const raw: string[] = login.headers["set-cookie"] as unknown as string[];
    const cookie = raw.map((c) => c.split(";")[0]).join("; ");

    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("admin@test.local");
  });

  it("rejects a missing token with 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Authentication required");
  });
});

describe("POST /api/auth/logout", () => {
  it("succeeds and clears the cookie", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
    expect(res.headers["set-cookie"]?.[0] ?? "").toContain("medguard_token=;");
  });
  /**
   * Logout has no genuine failure path: it is public, and clearing a cookie
   * that is not there is not an error. These two pin that down as intended
   * behaviour rather than an accident of routing.
   */
  it("is callable without a session, since a logged-out client still has a cookie to clear", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
  });

  it("is idempotent — calling it twice is not an error", async () => {
    await request(app).post("/api/auth/logout");
    expect((await request(app).post("/api/auth/logout")).status).toBe(200);
  });

});
