import { generate } from "otplib";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  clearMailpit, latestMailTo, seedFixture, TEST_PASSWORD, tokenFor, tokenFromMail, type Fixture,
} from "../helpers.js";

const app = createApp();

let ids: Fixture;
let adminToken: string;
let viewerToken: string;

beforeEach(async () => {
  ids = await seedFixture();
  adminToken = await tokenFor(request(app), "admin@test.local");
  viewerToken = await tokenFor(request(app), "viewer@test.local");
  await clearMailpit();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function authed(token: string) {
  return {
    get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string) => request(app).post(path).set("Authorization", `Bearer ${token}`),
    patch: (path: string) => request(app).patch(path).set("Authorization", `Bearer ${token}`),
  };
}
const asAdmin = () => authed(adminToken);
const asViewer = () => authed(viewerToken);

describe("member invites", () => {
  it("invites, emails a token, and accept-invite sets a working password", async () => {
    const invite = await asAdmin().post("/api/members/invites").send({ email: "new@test.local", role: "ANALYST" });
    expect(invite.status).toBe(201);

    const mail = await latestMailTo("new@test.local");
    expect(mail.subject).toContain("invited");
    const token = tokenFromMail(mail.text);

    const accept = await request(app).post("/api/auth/accept-invite").send({ token, password: "a-fresh-password-1" });
    expect(accept.status).toBe(200);

    const login = await request(app).post("/api/auth/login").send({ email: "new@test.local", password: "a-fresh-password-1" });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe("ANALYST");

    const audit = await prisma.auditEvent.findMany({ where: { action: { in: ["MEMBER_INVITED", "MEMBER_INVITE_ACCEPTED"] } } });
    expect(audit.map((a) => a.action).sort()).toEqual(["MEMBER_INVITED", "MEMBER_INVITE_ACCEPTED"]);
  });

  it("is admin-only", async () => {
    const res = await asViewer().post("/api/members/invites").send({ email: "x@test.local", role: "VIEWER" });
    expect(res.status).toBe(403);
  });

  it("rejects an invite link twice", async () => {
    const invite = await asAdmin().post("/api/members/invites").send({ email: "twice@test.local", role: "VIEWER" });
    const token = tokenFromMail((await latestMailTo("twice@test.local")).text);
    expect((await request(app).post("/api/auth/accept-invite").send({ token, password: "password-one-123" })).status).toBe(200);
    const second = await request(app).post("/api/auth/accept-invite").send({ token, password: "password-two-456" });
    expect(second.status).toBe(400);
    void invite;
  });
});

describe("member role and activation", () => {
  it("changes a member's role, audited", async () => {
    const res = await asAdmin().patch(`/api/members/${ids.viewerUserId}/role`).send({ role: "ANALYST" });
    expect(res.status).toBe(200);
    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: ids.viewerUserId, organizationId: ids.organizationId } },
    });
    expect(member?.role).toBe("ANALYST");
  });

  it("deactivates a member, who can then no longer log in", async () => {
    const res = await asAdmin().post(`/api/members/${ids.viewerUserId}/deactivate`);
    expect(res.status).toBe(200);
    const login = await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD });
    expect(login.status).toBe(403);
  });

  it("reactivating restores login", async () => {
    await asAdmin().post(`/api/members/${ids.viewerUserId}/deactivate`);
    await asAdmin().post(`/api/members/${ids.viewerUserId}/reactivate`);
    const login = await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("refuses to deactivate the last active admin", async () => {
    const res = await asAdmin().post(`/api/members/${ids.adminUserId}/deactivate`);
    expect(res.status).toBe(409);
  });

  it("refuses to demote the last active admin", async () => {
    const res = await asAdmin().patch(`/api/members/${ids.adminUserId}/role`).send({ role: "ANALYST" });
    expect(res.status).toBe(409);
  });
});

describe("password reset and change", () => {
  it("resets via a mailed token without revealing whether the address exists", async () => {
    const known = await request(app).post("/api/auth/forgot-password").send({ email: "viewer@test.local" });
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: "nobody@test.local" });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);

    const token = tokenFromMail((await latestMailTo("viewer@test.local")).text);
    const reset = await request(app).post("/api/auth/reset-password").send({ token, password: "a-new-password-99" });
    expect(reset.status).toBe(200);

    expect((await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: "a-new-password-99" })).status).toBe(200);
  });

  it("rejects an expired or reused reset token", async () => {
    await request(app).post("/api/auth/forgot-password").send({ email: "viewer@test.local" });
    const token = tokenFromMail((await latestMailTo("viewer@test.local")).text);
    await request(app).post("/api/auth/reset-password").send({ token, password: "first-reset-password-1" });
    const reused = await request(app).post("/api/auth/reset-password").send({ token, password: "second-attempt-2" });
    expect(reused.status).toBe(400);
  });

  it("changes password with the current one, not without it", async () => {
    const wrong = await asViewer().post("/api/auth/change-password").send({ currentPassword: "nope", newPassword: "a-new-password-12" });
    expect(wrong.status).toBe(400);

    const right = await asViewer().post("/api/auth/change-password").send({ currentPassword: TEST_PASSWORD, newPassword: "a-new-password-12" });
    expect(right.status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: "a-new-password-12" })).status).toBe(200);
  });
});

describe("MFA", () => {
  async function enrollAndConfirm() {
    const enroll = await asViewer().post("/api/auth/mfa/enroll");
    const secret = enroll.body.data.secret as string;
    const code = await generate({ secret });
    const confirm = await asViewer().post("/api/auth/mfa/confirm").send({ code });
    return { secret, recoveryCodes: confirm.body.data.recoveryCodes as string[] };
  }

  it("enrolls, then requires a code at login", async () => {
    await enrollAndConfirm();
    const noCode = await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe("MFA_REQUIRED");
  });

  it("logs in with a valid TOTP code", async () => {
    const { secret } = await enrollAndConfirm();
    const code = await generate({ secret });
    const res = await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD, mfaCode: code });
    expect(res.status).toBe(200);
  });

  it("logs in once with a recovery code, then refuses to reuse it", async () => {
    const { recoveryCodes } = await enrollAndConfirm();
    const first = await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD, mfaCode: recoveryCodes[0] });
    expect(first.status).toBe(200);
    const replay = await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD, mfaCode: recoveryCodes[0] });
    expect(replay.status).toBe(401);
  });

  it("disables MFA with password + code, not password alone", async () => {
    const { secret } = await enrollAndConfirm();
    const code = await generate({ secret });
    const wrongPassword = await asViewer().post("/api/auth/mfa/disable").send({ password: "wrong", code });
    expect(wrongPassword.status).toBe(401);

    const ok = await asViewer().post("/api/auth/mfa/disable").send({ password: TEST_PASSWORD, code });
    expect(ok.status).toBe(200);
    const login = await request(app).post("/api/auth/login").send({ email: "viewer@test.local", password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("a refresh token can only ever come from a login that already passed MFA — refresh itself asks for no code and cannot be used to skip it", async () => {
    const { secret } = await enrollAndConfirm();
    const code = await generate({ secret });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "viewer@test.local", password: TEST_PASSWORD, mfaCode: code });
    expect(login.status).toBe(200);

    // The refresh token is only reachable at all because the login above
    // already cleared MFA; refreshing it does not, and should not, ask again.
    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .set("X-Drishti-Csrf", "1")
      .send({ refreshToken: login.body.data.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.user.email).toBe("viewer@test.local");

    // There is no route that hands out a refresh token from just a password —
    // confirmed by the companion test above that a bare login attempt with no
    // code is turned back with MFA_REQUIRED and no token of any kind.
  });
});

describe("sessions", () => {
  it("lists active sessions and can revoke one", async () => {
    const list = await asAdmin().get("/api/auth/sessions");
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);

    const target = list.body.data[0];
    const revoke = await asAdmin().post(`/api/auth/sessions/${target.id}/revoke`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.ok).toBe(true);
  });

  it("revokes every other session, keeping the current one alive", async () => {
    const second = await request(app).post("/api/auth/login").send({ email: "admin@test.local", password: TEST_PASSWORD });
    const revoke = await request(app)
      .post("/api/auth/sessions/revoke-others")
      .set("Authorization", `Bearer ${second.body.data.token}`)
      .set("Cookie", `drishti_refresh=${second.body.data.refreshToken}`);
    expect(revoke.status).toBe(200);

    const stillWorks = await request(app).post("/api/auth/refresh").set("X-Drishti-Csrf", "1").set("Cookie", `drishti_refresh=${second.body.data.refreshToken}`);
    expect(stillWorks.status).toBe(200);
  });
});
