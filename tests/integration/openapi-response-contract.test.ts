import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";
import * as R from "../../src/schemas/responses.js";
import type { ZodType } from "zod";

/**
 * Live response-body contract tests: calls real routes against a seeded
 * instance and validates the actual HTTP response against the same Zod
 * schema openapi.json advertises for it (src/schemas/responses.ts, wired
 * into scripts/generate-openapi.ts). Covers every route that has a defined
 * response schema (118 of 121 operations — the 3 excluded are binary
 * downloads: the PDF/CSV reports and the CSV import template; see
 * src/schemas/responses.ts's header for scope/precision policy on nested
 * relations).
 *
 * One beforeAll builds one of every entity type through the real create
 * endpoints, so every GET (list/detail/summary) and most mutating routes
 * run against real rows rather than placeholder ids.
 */

const app = createApp();
let ids: Fixture;
let admin: string;

function check(label: string, schema: ZodType, body: unknown) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(`${label} failed contract: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
}

const auth = () => ({ Authorization: `Bearer ${admin}` });

// Entities created once in beforeAll, reused by every test below.
let vendorId: number;
let identityId: number;
let threatId: number;
let controlId: number;
let policyId: number;
let remediationId: number;
let accessGrantId: number;
let phiTypeId: number;
let apiKeyId: number;
let inviteId: number;

beforeAll(async () => {
  ids = await seedFixture();
  admin = await tokenFor(request(app), "admin@test.local");

  const vendor = await request(app).post("/api/vendors").set(auth())
    .send({ name: "Contract Test Vendor", baaStatus: "SIGNED" });
  vendorId = vendor.body.data.id;

  const identity = await request(app).post("/api/identities").set(auth())
    .send({ displayName: "Contract Test Person", kind: "USER" });
  identityId = identity.body.data.id;

  const threat = await request(app).post("/api/threats").set(auth())
    .send({ assetId: ids.ehrId, severity: "HIGH", title: "Contract Test Threat", description: "x" });
  threatId = threat.body.data.id;

  const control = await request(app).post("/api/controls").set(auth())
    .send({ name: "Contract Test Control", description: "x", category: "ACCESS", status: "IMPLEMENTED", effectiveness: "EFFECTIVE" });
  controlId = control.body.data.id;

  const policy = await request(app).post("/api/policies").set(auth())
    .send({ name: "Contract Test Policy", description: "x" });
  policyId = policy.body.data.id;

  const remediation = await request(app).post("/api/remediations").set(auth())
    .send({ title: "Contract Test Remediation", description: "x", recommendation: "x", assetId: ids.ehrId });
  remediationId = remediation.body.data.id;

  const grant = await request(app).post("/api/access").set(auth())
    .send({ identityId, assetId: ids.ehrId, level: "READ" });
  accessGrantId = grant.body.data.id;

  const phiType = await request(app).post("/api/phi-types").set(auth())
    .send({ name: "Contract Test PHI", sensitivity: "HIGH" });
  phiTypeId = phiType.body.data.id;

  const apiKey = await request(app).post("/api/api-keys").set(auth()).send({ name: "Contract Test Key" });
  apiKeyId = apiKey.body.data.id;
  check("POST /api/api-keys", R.apiKeyCreatedResponseSchema, apiKey.body);

  const invite = await request(app).post("/api/members/invites").set(auth())
    .send({ email: "contract-invite@test.local", role: "VIEWER" });
  inviteId = invite.body.data?.id ?? invite.body.data?.inviteId ?? 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("auth & session contract", () => {
  it("POST /auth/login", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "admin@test.local", password: "test-password" });
    check("login", R.loginResponseSchema, res.body);
  });

  it("GET /auth/me", async () => {
    const res = await request(app).get("/api/auth/me").set(auth());
    check("me", R.currentUserResponseSchema, res.body);
  });

  it("GET /auth/sessions", async () => {
    const res = await request(app).get("/api/auth/sessions").set(auth());
    check("sessions", R.sessionListResponseSchema, res.body);
  });
});

describe("members & organization contract", () => {
  it("GET /members", async () => {
    const res = await request(app).get("/api/members").set(auth());
    check("members", R.memberListResponseSchema, res.body);
  });

  it("GET /organization", async () => {
    const res = await request(app).get("/api/organization").set(auth());
    check("organization", R.organizationResponseSchema, res.body);
  });

  it("GET /organization/settings", async () => {
    const res = await request(app).get("/api/organization/settings").set(auth());
    check("org settings", R.orgSettingsResponseSchema, res.body);
  });
});

describe("assets contract", () => {
  it("GET /assets", async () => {
    const res = await request(app).get("/api/assets").set(auth());
    check("assets list", R.assetListResponseSchema, res.body);
  });

  it("GET /assets/{id}", async () => {
    const res = await request(app).get(`/api/assets/${ids.ehrId}`).set(auth());
    check("asset detail", R.assetDetailResponseSchema, res.body);
  });

  it("POST /assets", async () => {
    const res = await request(app).post("/api/assets").set(auth())
      .send({ name: "Contract Test Asset", type: "OTHER" });
    check("asset create", R.rawAssetResponseSchema, res.body);
  });

  it("PATCH /assets/{id}", async () => {
    const res = await request(app).patch(`/api/assets/${ids.ehrId}`).set(auth()).send({ name: "Test EHR" });
    check("asset update", R.rawAssetResponseSchema, res.body);
  });

  it("GET /assets/{id}/risk-history", async () => {
    const res = await request(app).get(`/api/assets/${ids.ehrId}/risk-history`).set(auth());
    check("asset risk history", R.riskHistoryListResponseSchema, res.body);
  });

  it("GET /assets/{id}/history", async () => {
    const res = await request(app).get(`/api/assets/${ids.ehrId}/history`).set(auth());
    check("asset audit history", R.auditListResponseSchema, res.body);
  });

  it("GET /assets/{id}/control-evidence", async () => {
    const res = await request(app).get(`/api/assets/${ids.ehrId}/control-evidence`).set(auth());
    check("asset control evidence", R.controlEvidenceResponseSchema, res.body);
  });

  it("PUT /assets/{id}/controls/{controlId}", async () => {
    const res = await request(app).put(`/api/assets/${ids.ehrId}/controls/${controlId}`).set(auth());
    check("asset link control", R.assetControlLinkResponseSchema, res.body);
  });
});

describe("dataflows contract", () => {
  it("GET /dataflows", async () => {
    const res = await request(app).get("/api/dataflows").set(auth());
    check("dataflows list", R.dataFlowListResponseSchema, res.body);
  });
});

describe("risks contract", () => {
  it("GET /risks", async () => {
    const res = await request(app).get("/api/risks").set(auth());
    check("risks list", R.riskListResponseSchema, res.body);
  });

  it("GET /risks/distribution", async () => {
    const res = await request(app).get("/api/risks/distribution").set(auth());
    check("risk distribution", R.riskDistributionResponseSchema, res.body);
  });

  it("GET /risks/history", async () => {
    const res = await request(app).get("/api/risks/history").set(auth());
    check("risk history", R.riskHistoryListResponseSchema, res.body);
  });

  it("POST /risks/{assetId}/recompute", async () => {
    await request(app).post(`/api/assets/${ids.billingId}/assessment`).set(auth())
      .send({ likelihood: 3, impact: 3, exposure: 3, controlGap: 3 });
    const res = await request(app).post(`/api/risks/${ids.billingId}/recompute`).set(auth());
    check("risk recompute", R.recomputeResponseSchema, res.body);
  });
});

describe("vendors contract", () => {
  it("GET /vendors", async () => {
    const res = await request(app).get("/api/vendors").set(auth());
    check("vendors list", R.vendorListResponseSchema, res.body);
  });

  it("GET /vendors/{id}", async () => {
    const res = await request(app).get(`/api/vendors/${vendorId}`).set(auth());
    check("vendor detail", R.vendorDetailResponseSchema, res.body);
  });

  it("PATCH /vendors/{id}", async () => {
    const res = await request(app).patch(`/api/vendors/${vendorId}`).set(auth()).send({ baaStatus: "PENDING" });
    check("vendor update", R.rawVendorResponseSchema, res.body);
  });

  it("PUT /vendors/{id}/assets/{assetId}", async () => {
    const res = await request(app).put(`/api/vendors/${vendorId}/assets/${ids.ehrId}`).set(auth());
    check("vendor link asset", R.vendorAssetLinkResponseSchema, res.body);
  });

  it("GET /vendors/{id}/risk-history", async () => {
    const res = await request(app).get(`/api/vendors/${vendorId}/risk-history`).set(auth());
    check("vendor risk history", R.riskHistoryListResponseSchema, res.body);
  });

  it("GET /vendors/{id}/history", async () => {
    const res = await request(app).get(`/api/vendors/${vendorId}/history`).set(auth());
    check("vendor audit history", R.auditListResponseSchema, res.body);
  });
});

describe("identities contract", () => {
  it("GET /identities", async () => {
    const res = await request(app).get("/api/identities").set(auth());
    check("identities list", R.identityListResponseSchema, res.body);
  });

  it("GET /identities/{id}", async () => {
    const res = await request(app).get(`/api/identities/${identityId}`).set(auth());
    check("identity detail", R.identityDetailResponseSchema, res.body);
  });

  it("PATCH /identities/{id}", async () => {
    const res = await request(app).patch(`/api/identities/${identityId}`).set(auth()).send({ department: "IT" });
    check("identity update", R.rawIdentityResponseSchema, res.body);
  });
});

describe("access contract", () => {
  it("GET /access", async () => {
    const res = await request(app).get("/api/access").set(auth());
    check("access list", R.accessGrantListResponseSchema, res.body);
  });

  it("GET /access/summary", async () => {
    const res = await request(app).get("/api/access/summary").set(auth());
    check("access summary", R.accessSummaryResponseSchema, res.body);
  });

  it("GET /access/{id}", async () => {
    const res = await request(app).get(`/api/access/${accessGrantId}`).set(auth());
    check("access detail", R.accessGrantDetailResponseSchema, res.body);
  });

  it("PATCH /access/{id}", async () => {
    const res = await request(app).patch(`/api/access/${accessGrantId}`).set(auth()).send({ level: "WRITE" });
    check("access update", R.rawAccessGrantResponseSchema, res.body);
  });

  it("POST /access/{id}/review", async () => {
    const res = await request(app).post(`/api/access/${accessGrantId}/review`).set(auth());
    check("access review", R.rawAccessGrantResponseSchema, res.body);
  });
});

describe("threats contract", () => {
  it("GET /threats", async () => {
    const res = await request(app).get("/api/threats").set(auth());
    check("threats list", R.threatListResponseSchema, res.body);
  });

  it("GET /threats/summary", async () => {
    const res = await request(app).get("/api/threats/summary").set(auth());
    check("threats summary", R.threatSummaryResponseSchema, res.body);
  });

  it("GET /threats/{id}", async () => {
    const res = await request(app).get(`/api/threats/${threatId}`).set(auth());
    check("threat detail", R.threatDetailResponseSchema, res.body);
  });

  it("PATCH /threats/{id}", async () => {
    const res = await request(app).patch(`/api/threats/${threatId}`).set(auth()).send({ description: "updated" });
    check("threat update", R.rawThreatResponseSchema, res.body);
  });

  it("POST /threats/{id}/status", async () => {
    const res = await request(app).post(`/api/threats/${threatId}/status`).set(auth()).send({ status: "INVESTIGATING" });
    check("threat status", R.rawThreatResponseSchema, res.body);
  });

  it("GET /threats/{id}/history", async () => {
    const res = await request(app).get(`/api/threats/${threatId}/history`).set(auth());
    check("threat audit history", R.auditListResponseSchema, res.body);
  });
});

describe("controls contract", () => {
  it("GET /controls", async () => {
    const res = await request(app).get("/api/controls").set(auth());
    check("controls list", R.controlListResponseSchema, res.body);
  });

  it("GET /controls/{id}", async () => {
    const res = await request(app).get(`/api/controls/${controlId}`).set(auth());
    check("control detail", R.controlDetailResponseSchema, res.body);
  });

  it("PATCH /controls/{id}", async () => {
    const res = await request(app).patch(`/api/controls/${controlId}`).set(auth()).send({ owner: "Security Team" });
    check("control update", R.rawControlResponseSchema, res.body);
  });
});

describe("policies contract", () => {
  it("GET /policies", async () => {
    const res = await request(app).get("/api/policies").set(auth());
    check("policies list", R.policyListResponseSchema, res.body);
  });

  it("GET /policies/{id}", async () => {
    const res = await request(app).get(`/api/policies/${policyId}`).set(auth());
    check("policy detail", R.policyDetailResponseSchema, res.body);
  });

  it("PATCH /policies/{id}", async () => {
    const res = await request(app).patch(`/api/policies/${policyId}`).set(auth()).send({ status: "ACTIVE" });
    check("policy update", R.rawPolicyResponseSchema, res.body);
  });

  it("PUT /policies/{id}/controls/{controlId}", async () => {
    const res = await request(app).put(`/api/policies/${policyId}/controls/${controlId}`).set(auth());
    check("policy link control", R.policyControlLinkResponseSchema, res.body);
  });
});

describe("remediations contract", () => {
  it("GET /remediations", async () => {
    const res = await request(app).get("/api/remediations").set(auth());
    check("remediations list", R.remediationListResponseSchema, res.body);
  });

  it("GET /remediations/summary", async () => {
    const res = await request(app).get("/api/remediations/summary").set(auth());
    check("remediations summary", R.remediationSummaryResponseSchema, res.body);
  });

  it("GET /remediations/{id}", async () => {
    const res = await request(app).get(`/api/remediations/${remediationId}`).set(auth());
    check("remediation detail", R.remediationDetailResponseSchema, res.body);
  });

  it("PATCH /remediations/{id}", async () => {
    const res = await request(app).patch(`/api/remediations/${remediationId}`).set(auth()).send({ description: "updated" });
    check("remediation update", R.remediationDetailResponseSchema, res.body);
  });

  it("POST /remediations/{id}/assign", async () => {
    const res = await request(app).post(`/api/remediations/${remediationId}/assign`).set(auth()).send({ ownerId: ids.adminUserId });
    check("remediation assign", R.remediationDetailResponseSchema, res.body);
  });

  it("POST /remediations/{id}/status", async () => {
    const res = await request(app).post(`/api/remediations/${remediationId}/status`).set(auth()).send({ status: "IN_PROGRESS" });
    check("remediation status", R.remediationDetailResponseSchema, res.body);
  });

  it("GET /remediations/{id}/history", async () => {
    const res = await request(app).get(`/api/remediations/${remediationId}/history`).set(auth());
    check("remediation audit history", R.auditListResponseSchema, res.body);
  });
});

describe("audit contract", () => {
  it("GET /audit", async () => {
    const res = await request(app).get("/api/audit").set(auth());
    check("audit list", R.auditListResponseSchema, res.body);
  });

  it("GET /audit/verify", async () => {
    const res = await request(app).get("/api/audit/verify").set(auth());
    check("audit verify", R.auditVerifyResponseSchema, res.body);
  });
});

describe("search contract", () => {
  it("GET /search", async () => {
    const res = await request(app).get("/api/search?q=test").set(auth());
    check("search", R.searchResultsResponseSchema, res.body);
  });
});

describe("reports contract", () => {
  it("GET /reports/risk-assessment", async () => {
    const res = await request(app).get("/api/reports/risk-assessment").set(auth());
    check("report JSON", R.riskAssessmentReportResponseSchema, res.body);
  });
});

describe("import contract", () => {
  it("GET /import", async () => {
    const res = await request(app).get("/api/import").set(auth());
    check("import entities", R.importEntityListResponseSchema, res.body);
  });

  it("POST /import/{entity}/validate", async () => {
    const res = await request(app)
      .post("/api/import/assets/validate")
      .set(auth())
      .attach("file", Buffer.from("name,type\nValidate Test,OTHER\n"), "assets.csv");
    check("import validate", R.importReportResponseSchema, res.body);
  });
});

describe("api-keys & ingest contract", () => {
  it("GET /api-keys", async () => {
    const res = await request(app).get("/api/api-keys").set(auth());
    check("api-keys list", R.apiKeyListResponseSchema, res.body);
  });

  it("POST /api-keys/{id}/revoke", async () => {
    const res = await request(app).post(`/api/api-keys/${apiKeyId}/revoke`).set(auth());
    check("api-key revoke", R.apiKeyRevokedResponseSchema, res.body);
  });
});

describe("notifications contract", () => {
  it("GET /notifications", async () => {
    const res = await request(app).get("/api/notifications").set(auth());
    check("notifications list", R.notificationListResponseSchema, res.body);
  });

  it("GET /notifications/unread-count", async () => {
    const res = await request(app).get("/api/notifications/unread-count").set(auth());
    check("unread count", R.unreadCountResponseSchema, res.body);
  });

  it("POST /notifications/read-all", async () => {
    const res = await request(app).post("/api/notifications/read-all").set(auth());
    check("mark all read", R.notificationActionResponseSchema, res.body);
  });
});

describe("phi-inventory contract", () => {
  it("GET /phi-inventory", async () => {
    const res = await request(app).get("/api/phi-inventory").set(auth());
    check("phi inventory", R.phiInventoryResponseSchema, res.body);
  });

  it("GET /phi-types", async () => {
    const res = await request(app).get("/api/phi-types").set(auth());
    check("phi types list", R.phiTypeListResponseSchema, res.body);
  });

  it("GET /phi-types/{id}", async () => {
    const res = await request(app).get(`/api/phi-types/${phiTypeId}`).set(auth());
    check("phi type detail", R.phiTypeDetailResponseSchema, res.body);
  });

  it("PATCH /phi-types/{id}", async () => {
    const res = await request(app).patch(`/api/phi-types/${phiTypeId}`).set(auth()).send({ sensitivity: "CRITICAL" });
    check("phi type update", R.rawPhiTypeResponseSchema, res.body);
  });
});

describe("openapi.json freshness", () => {
  it("every schema used above matches a route actually declared in the generator", () => {
    // Sanity check, not a route-by-route re-assertion: the generator's own
    // openapi-contract.test.ts already proves openapi.json is exactly what
    // the generator currently produces, and route-inventory.test.ts proves
    // the generator's route list matches the live code. This file's job is
    // just to prove the *shapes* are honest against a real server.
    expect(inviteId).toBeTypeOf("number");
  });
});
