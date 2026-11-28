/**
 * Generates openapi.json from the Zod schemas that already validate every
 * route, using Zod 4's native `z.toJSONSchema` (OpenAPI 3.1 accepts JSON
 * Schema 2020-12 directly, so no separate zod-to-openapi dependency is
 * needed — confirmed compatible with the installed Zod 4.6.2 before picking
 * this approach; see docs/engineering/DECISIONS.md).
 *
 * The path list below is transcribed from docs/engineering/ROUTE_INVENTORY.md
 * (itself read directly off the mounted routers in src/app.ts), not
 * re-derived here, so regenerating this file after a route change means
 * updating both the inventory and this list together.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z, type ZodType } from "zod";
import * as access from "../src/routes/access.js";
import * as apiKeys from "../src/routes/apiKeys.js";
import * as assets from "../src/routes/assets.js";
import * as auth from "../src/routes/auth.js";
import * as controls from "../src/routes/controls.js";
import * as dataflows from "../src/routes/dataflows.js";
import * as identities from "../src/routes/identities.js";
import * as members from "../src/routes/members.js";
import * as notifications from "../src/routes/notifications.js";
import * as organization from "../src/routes/organization.js";
import * as phiTypes from "../src/routes/phiInventory.js";
import * as policies from "../src/routes/policies.js";
import * as remediations from "../src/routes/remediations.js";
import * as risks from "../src/routes/risks.js";
import * as search from "../src/routes/search.js";
import * as threats from "../src/routes/threats.js";
import * as vendors from "../src/routes/vendors.js";
import { paginationQuery } from "../src/lib/pagination.js";
import {
  accessGrantDetailResponseSchema,
  accessGrantListResponseSchema,
  accessSummaryResponseSchema,
  apiKeyCreatedResponseSchema,
  apiKeyListResponseSchema,
  apiKeyRevokedResponseSchema,
  assetControlLinkResponseSchema,
  assetDetailResponseSchema,
  assetListResponseSchema,
  auditListResponseSchema,
  auditVerifyResponseSchema,
  controlDetailResponseSchema,
  controlEvidenceResponseSchema,
  controlListResponseSchema,
  currentUserResponseSchema,
  dataFlowDetailResponseSchema,
  dataFlowListResponseSchema,
  identityDetailResponseSchema,
  identityListResponseSchema,
  importEntityListResponseSchema,
  importReportResponseSchema,
  ingestResultResponseSchema,
  loginResponseSchema,
  memberListResponseSchema,
  mfaConfirmResponseSchema,
  mfaEnrollResponseSchema,
  notificationActionResponseSchema,
  notificationListResponseSchema,
  okResponseSchema,
  orgSettingsResponseSchema,
  organizationMemberListResponseSchema,
  organizationResponseSchema,
  phiInventoryResponseSchema,
  phiTypeDetailResponseSchema,
  phiTypeListResponseSchema,
  policyControlLinkResponseSchema,
  policyDetailResponseSchema,
  policyListResponseSchema,
  rawAccessGrantResponseSchema,
  rawAssetResponseSchema,
  rawControlResponseSchema,
  rawIdentityResponseSchema,
  rawPhiTypeResponseSchema,
  rawPolicyResponseSchema,
  rawThreatResponseSchema,
  rawVendorResponseSchema,
  recomputeResponseSchema,
  remediationDetailResponseSchema,
  remediationListResponseSchema,
  remediationSummaryResponseSchema,
  riskAssessmentReportResponseSchema,
  riskDistributionResponseSchema,
  riskHistoryListResponseSchema,
  riskListResponseSchema,
  searchResultsResponseSchema,
  sessionListResponseSchema,
  threatDetailResponseSchema,
  threatListResponseSchema,
  threatSummaryResponseSchema,
  unreadCountResponseSchema,
  vendorAssetLinkResponseSchema,
  vendorDetailResponseSchema,
  vendorListResponseSchema,
} from "../src/schemas/responses.js";

type RouteSpec = {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string; // OpenAPI-style, e.g. /assets/{id}
  tag: string;
  summary: string;
  auth: "public" | "session";
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  /**
   * Optional 200-response schema. Most routes don't have one yet — see
   * src/schemas/responses.ts's header comment for scope — so `responses`
   * falls back to the bare `{ description: "Success" }` it always had when
   * this is absent.
   */
  response?: ZodType;
};

// import.ts reads :entity straight off req.params with no validate()
// middleware (requireSpec() does its own lookup/404), so there is no
// existing Zod schema to import for it; same for ingest.ts's :recordType.
const entityParam = z.object({ entity: z.string() });
const recordTypeParam = z.object({ recordType: z.string() });
const templateFormatQuery = z.object({ format: z.enum(["csv", "xlsx"]).optional() });

const ROUTES: RouteSpec[] = [
  { method: "post", path: "/auth/login", tag: "Auth", summary: "Log in (may require a second call with mfaCode)", auth: "public", body: auth.loginBody , response: loginResponseSchema },
  { method: "post", path: "/auth/refresh", tag: "Auth", summary: "Rotate the refresh token", auth: "session" , response: loginResponseSchema },
  { method: "post", path: "/auth/logout", tag: "Auth", summary: "Log out this session", auth: "session" , response: okResponseSchema },
  { method: "post", path: "/auth/logout-all", tag: "Auth", summary: "Revoke every session", auth: "session" , response: okResponseSchema },
  { method: "get", path: "/auth/me", tag: "Auth", summary: "Current user", auth: "session" , response: currentUserResponseSchema },
  { method: "post", path: "/auth/accept-invite", tag: "Auth", summary: "Accept an invite and set a password", auth: "public" , response: okResponseSchema },
  { method: "post", path: "/auth/forgot-password", tag: "Auth", summary: "Request a password reset email", auth: "public" , response: okResponseSchema },
  { method: "post", path: "/auth/reset-password", tag: "Auth", summary: "Reset password with a mailed token", auth: "public" , response: okResponseSchema },
  { method: "post", path: "/auth/change-password", tag: "Auth", summary: "Change password (requires current)", auth: "session" , response: okResponseSchema },
  { method: "post", path: "/auth/mfa/enroll", tag: "Auth", summary: "Start TOTP enrollment", auth: "session" , response: mfaEnrollResponseSchema },
  { method: "post", path: "/auth/mfa/confirm", tag: "Auth", summary: "Confirm enrollment, receive recovery codes", auth: "session" , response: mfaConfirmResponseSchema },
  { method: "post", path: "/auth/mfa/disable", tag: "Auth", summary: "Disable MFA (password + code)", auth: "session" , response: okResponseSchema },
  { method: "get", path: "/auth/sessions", tag: "Auth", summary: "List active sessions", auth: "session" , response: sessionListResponseSchema },
  { method: "post", path: "/auth/sessions/{id}/revoke", tag: "Auth", summary: "Revoke one session", auth: "session", params: auth.sessionIdParam , response: okResponseSchema },
  { method: "post", path: "/auth/sessions/revoke-others", tag: "Auth", summary: "Revoke every other session", auth: "session" , response: okResponseSchema },

  { method: "get", path: "/members", tag: "Members", summary: "List organization members", auth: "session" , response: memberListResponseSchema },
  { method: "post", path: "/members/invites", tag: "Members", summary: "Invite a member (ADMIN only)", auth: "session" , response: okResponseSchema },
  { method: "post", path: "/members/invites/{inviteId}/resend", tag: "Members", summary: "Resend an invite (ADMIN only)", auth: "session", params: members.inviteIdParam , response: okResponseSchema },
  { method: "delete", path: "/members/invites/{inviteId}", tag: "Members", summary: "Revoke an invite (ADMIN only)", auth: "session", params: members.inviteIdParam , response: okResponseSchema },
  { method: "patch", path: "/members/{userId}/role", tag: "Members", summary: "Change a member's role (ADMIN only)", auth: "session", params: members.userIdParam , response: okResponseSchema },
  { method: "post", path: "/members/{userId}/deactivate", tag: "Members", summary: "Deactivate a member (ADMIN only)", auth: "session", params: members.userIdParam , response: okResponseSchema },
  { method: "post", path: "/members/{userId}/reactivate", tag: "Members", summary: "Reactivate a member (ADMIN only)", auth: "session", params: members.userIdParam , response: okResponseSchema },

  { method: "get", path: "/organization", tag: "Organization", summary: "Current organization", auth: "session" , response: organizationResponseSchema },
  { method: "get", path: "/organization/members", tag: "Organization", summary: "List members", auth: "session" , response: organizationMemberListResponseSchema },
  { method: "get", path: "/organization/settings", tag: "Organization", summary: "Configurable thresholds", auth: "session" , response: orgSettingsResponseSchema },
  { method: "patch", path: "/organization/settings", tag: "Organization", summary: "Update thresholds (ADMIN only)", auth: "session", body: organization.settingsBody , response: orgSettingsResponseSchema },

  { method: "get", path: "/assets", tag: "Assets", summary: "List assets", auth: "session", query: assets.listQuery, response: assetListResponseSchema },
  { method: "get", path: "/assets/{id}", tag: "Assets", summary: "Get an asset", auth: "session", params: assets.idParam , response: assetDetailResponseSchema },
  { method: "post", path: "/assets", tag: "Assets", summary: "Create an asset", auth: "session", body: assets.createBody , response: rawAssetResponseSchema },
  { method: "patch", path: "/assets/{id}", tag: "Assets", summary: "Update an asset", auth: "session", params: assets.idParam, body: assets.patchBody , response: rawAssetResponseSchema },
  { method: "post", path: "/assets/{id}/archive", tag: "Assets", summary: "Archive an asset", auth: "session", params: assets.idParam , response: rawAssetResponseSchema },
  { method: "post", path: "/assets/{id}/restore", tag: "Assets", summary: "Restore an asset", auth: "session", params: assets.idParam , response: rawAssetResponseSchema },
  { method: "post", path: "/assets/{id}/assessment", tag: "Assets", summary: "Record a risk assessment", auth: "session", params: assets.idParam, body: assets.assessmentBody , response: recomputeResponseSchema },
  { method: "post", path: "/assets/{id}/recompute", tag: "Assets", summary: "Recompute risk", auth: "session", params: assets.idParam , response: recomputeResponseSchema },
  { method: "get", path: "/assets/{id}/risk-history", tag: "Assets", summary: "Risk history", auth: "session", params: assets.idParam, query: paginationQuery , response: riskHistoryListResponseSchema },
  { method: "get", path: "/assets/{id}/history", tag: "Assets", summary: "Audit history", auth: "session", params: assets.idParam, query: paginationQuery , response: auditListResponseSchema },
  { method: "get", path: "/assets/{id}/control-evidence", tag: "Assets", summary: "Control evidence", auth: "session", params: assets.idParam , response: controlEvidenceResponseSchema },
  { method: "put", path: "/assets/{id}/controls/{controlId}", tag: "Assets", summary: "Link a control", auth: "session", params: assets.controlLinkParams , response: assetControlLinkResponseSchema },
  { method: "delete", path: "/assets/{id}/controls/{controlId}", tag: "Assets", summary: "Unlink a control", auth: "session", params: assets.controlLinkParams , response: assetControlLinkResponseSchema },

  { method: "get", path: "/dataflows", tag: "DataFlows", summary: "List data flows", auth: "session", query: dataflows.listQuery , response: dataFlowListResponseSchema },
  { method: "get", path: "/dataflows/{id}", tag: "DataFlows", summary: "Get a data flow", auth: "session", params: dataflows.idParam , response: dataFlowDetailResponseSchema },

  { method: "get", path: "/risks", tag: "Risks", summary: "List risks", auth: "session", query: risks.listQuery , response: riskListResponseSchema },
  { method: "get", path: "/risks/distribution", tag: "Risks", summary: "Risk band distribution", auth: "session" , response: riskDistributionResponseSchema },
  { method: "get", path: "/risks/history", tag: "Risks", summary: "Risk history", auth: "session", query: risks.historyQuery , response: riskHistoryListResponseSchema },
  { method: "post", path: "/risks/{assetId}/recompute", tag: "Risks", summary: "Recompute an asset's risk", auth: "session", params: risks.assetIdParam , response: recomputeResponseSchema },

  { method: "get", path: "/vendors", tag: "Vendors", summary: "List vendors", auth: "session", query: vendors.listQuery , response: vendorListResponseSchema },
  { method: "get", path: "/vendors/{id}", tag: "Vendors", summary: "Get a vendor", auth: "session", params: vendors.idParam , response: vendorDetailResponseSchema },
  { method: "post", path: "/vendors", tag: "Vendors", summary: "Create a vendor", auth: "session", body: vendors.createBody , response: rawVendorResponseSchema },
  { method: "patch", path: "/vendors/{id}", tag: "Vendors", summary: "Update a vendor", auth: "session", params: vendors.idParam, body: vendors.patchBody , response: rawVendorResponseSchema },
  { method: "post", path: "/vendors/{id}/archive", tag: "Vendors", summary: "Archive a vendor", auth: "session", params: vendors.idParam , response: rawVendorResponseSchema },
  { method: "post", path: "/vendors/{id}/restore", tag: "Vendors", summary: "Restore a vendor", auth: "session", params: vendors.idParam , response: rawVendorResponseSchema },
  { method: "post", path: "/vendors/{id}/assessment", tag: "Vendors", summary: "Record a risk assessment", auth: "session", params: vendors.idParam, body: vendors.assessmentBody , response: recomputeResponseSchema },
  { method: "post", path: "/vendors/{id}/recompute", tag: "Vendors", summary: "Recompute risk", auth: "session", params: vendors.idParam , response: recomputeResponseSchema },
  { method: "put", path: "/vendors/{id}/assets/{assetId}", tag: "Vendors", summary: "Link an asset", auth: "session", params: vendors.assetLinkParams , response: vendorAssetLinkResponseSchema },
  { method: "delete", path: "/vendors/{id}/assets/{assetId}", tag: "Vendors", summary: "Unlink an asset", auth: "session", params: vendors.assetLinkParams , response: vendorAssetLinkResponseSchema },
  { method: "get", path: "/vendors/{id}/risk-history", tag: "Vendors", summary: "Risk history", auth: "session", params: vendors.idParam, query: paginationQuery , response: riskHistoryListResponseSchema },
  { method: "get", path: "/vendors/{id}/history", tag: "Vendors", summary: "Audit history", auth: "session", params: vendors.idParam, query: paginationQuery , response: auditListResponseSchema },

  { method: "get", path: "/identities", tag: "Identities", summary: "List identities", auth: "session", query: identities.listQuery , response: identityListResponseSchema },
  { method: "get", path: "/identities/{id}", tag: "Identities", summary: "Get an identity", auth: "session", params: identities.idParam , response: identityDetailResponseSchema },
  { method: "post", path: "/identities", tag: "Identities", summary: "Create an identity", auth: "session", body: identities.createBody , response: rawIdentityResponseSchema },
  { method: "patch", path: "/identities/{id}", tag: "Identities", summary: "Update an identity", auth: "session", params: identities.idParam, body: identities.patchBody , response: rawIdentityResponseSchema },
  { method: "post", path: "/identities/{id}/archive", tag: "Identities", summary: "Archive an identity", auth: "session", params: identities.idParam , response: rawIdentityResponseSchema },

  { method: "get", path: "/access", tag: "Access", summary: "List access grants", auth: "session", query: access.listQuery , response: accessGrantListResponseSchema },
  { method: "get", path: "/access/summary", tag: "Access", summary: "Access summary", auth: "session" , response: accessSummaryResponseSchema },
  { method: "get", path: "/access/{id}", tag: "Access", summary: "Get an access grant", auth: "session", params: access.idParam , response: accessGrantDetailResponseSchema },
  { method: "post", path: "/access", tag: "Access", summary: "Grant access", auth: "session", body: access.grantBody , response: rawAccessGrantResponseSchema },
  { method: "patch", path: "/access/{id}", tag: "Access", summary: "Update a grant", auth: "session", params: access.idParam, body: access.patchBody , response: rawAccessGrantResponseSchema },
  { method: "post", path: "/access/{id}/revoke", tag: "Access", summary: "Revoke a grant", auth: "session", params: access.idParam , response: rawAccessGrantResponseSchema },
  { method: "post", path: "/access/{id}/review", tag: "Access", summary: "Review a grant", auth: "session", params: access.idParam , response: rawAccessGrantResponseSchema },

  { method: "get", path: "/threats", tag: "Threats", summary: "List threats", auth: "session", query: threats.listQuery , response: threatListResponseSchema },
  { method: "get", path: "/threats/summary", tag: "Threats", summary: "Threats summary", auth: "session" , response: threatSummaryResponseSchema },
  { method: "get", path: "/threats/{id}", tag: "Threats", summary: "Get a threat", auth: "session", params: threats.idParam , response: threatDetailResponseSchema },
  { method: "post", path: "/threats", tag: "Threats", summary: "Create a threat", auth: "session", body: threats.createBody , response: rawThreatResponseSchema },
  { method: "patch", path: "/threats/{id}", tag: "Threats", summary: "Update a threat", auth: "session", params: threats.idParam, body: threats.patchBody , response: rawThreatResponseSchema },
  { method: "post", path: "/threats/{id}/status", tag: "Threats", summary: "Transition status", auth: "session", params: threats.idParam, body: threats.transitionBody , response: rawThreatResponseSchema },
  { method: "get", path: "/threats/{id}/history", tag: "Threats", summary: "Audit history", auth: "session", params: threats.idParam, query: paginationQuery , response: auditListResponseSchema },

  { method: "get", path: "/controls", tag: "Controls", summary: "List controls", auth: "session", query: controls.listQuery , response: controlListResponseSchema },
  { method: "get", path: "/controls/{id}", tag: "Controls", summary: "Get a control", auth: "session", params: controls.idParam , response: controlDetailResponseSchema },
  { method: "post", path: "/controls", tag: "Controls", summary: "Create a control", auth: "session", body: controls.createBody , response: rawControlResponseSchema },
  { method: "patch", path: "/controls/{id}", tag: "Controls", summary: "Update or assess a control", auth: "session", params: controls.idParam, body: controls.patchBody , response: rawControlResponseSchema },
  { method: "post", path: "/controls/{id}/archive", tag: "Controls", summary: "Archive a control", auth: "session", params: controls.idParam , response: rawControlResponseSchema },
  { method: "put", path: "/controls/{id}/assets/{assetId}", tag: "Controls", summary: "Link an asset", auth: "session", params: controls.linkParams , response: assetControlLinkResponseSchema },
  { method: "delete", path: "/controls/{id}/assets/{assetId}", tag: "Controls", summary: "Unlink an asset", auth: "session", params: controls.linkParams , response: assetControlLinkResponseSchema },

  { method: "get", path: "/policies", tag: "Policies", summary: "List policies", auth: "session", query: policies.listQuery , response: policyListResponseSchema },
  { method: "get", path: "/policies/{id}", tag: "Policies", summary: "Get a policy", auth: "session", params: policies.idParam , response: policyDetailResponseSchema },
  { method: "post", path: "/policies", tag: "Policies", summary: "Create a policy", auth: "session", body: policies.createBody , response: rawPolicyResponseSchema },
  { method: "patch", path: "/policies/{id}", tag: "Policies", summary: "Update a policy", auth: "session", params: policies.idParam, body: policies.patchBody , response: rawPolicyResponseSchema },
  { method: "post", path: "/policies/{id}/archive", tag: "Policies", summary: "Archive a policy", auth: "session", params: policies.idParam , response: rawPolicyResponseSchema },
  { method: "put", path: "/policies/{id}/controls/{controlId}", tag: "Policies", summary: "Link a control", auth: "session", params: policies.linkParams , response: policyControlLinkResponseSchema },
  { method: "delete", path: "/policies/{id}/controls/{controlId}", tag: "Policies", summary: "Unlink a control", auth: "session", params: policies.linkParams , response: policyControlLinkResponseSchema },

  { method: "get", path: "/remediations", tag: "Remediations", summary: "List remediations", auth: "session", query: remediations.listQuery , response: remediationListResponseSchema },
  { method: "get", path: "/remediations/summary", tag: "Remediations", summary: "Remediations summary", auth: "session" , response: remediationSummaryResponseSchema },
  { method: "get", path: "/remediations/{id}", tag: "Remediations", summary: "Get a remediation", auth: "session", params: remediations.idParam , response: remediationDetailResponseSchema },
  { method: "post", path: "/remediations", tag: "Remediations", summary: "Create a remediation", auth: "session", body: remediations.createBody , response: remediationDetailResponseSchema },
  { method: "patch", path: "/remediations/{id}", tag: "Remediations", summary: "Update a remediation", auth: "session", params: remediations.idParam, body: remediations.patchBody , response: remediationDetailResponseSchema },
  { method: "post", path: "/remediations/{id}/status", tag: "Remediations", summary: "Transition status", auth: "session", params: remediations.idParam, body: remediations.transitionBody , response: remediationDetailResponseSchema },
  { method: "post", path: "/remediations/{id}/assign", tag: "Remediations", summary: "Assign an owner", auth: "session", params: remediations.idParam, body: remediations.assignBody , response: remediationDetailResponseSchema },
  { method: "get", path: "/remediations/{id}/history", tag: "Remediations", summary: "Audit history", auth: "session", params: remediations.idParam, query: paginationQuery , response: auditListResponseSchema },

  { method: "get", path: "/audit", tag: "Audit", summary: "List audit events (ADMIN only)", auth: "session" , response: auditListResponseSchema },
  { method: "get", path: "/audit/verify", tag: "Audit", summary: "Verify the hash chain's integrity (ADMIN only)", auth: "session" , response: auditVerifyResponseSchema },

  { method: "get", path: "/search", tag: "Search", summary: "Global search", auth: "session", query: search.searchQuery , response: searchResultsResponseSchema },

  { method: "get", path: "/reports/risk-assessment", tag: "Reports", summary: "Risk assessment report (JSON)", auth: "session" , response: riskAssessmentReportResponseSchema },
  { method: "get", path: "/reports/risk-assessment.pdf", tag: "Reports", summary: "Risk assessment report (PDF)", auth: "session" },
  { method: "get", path: "/reports/risk-assessment.csv", tag: "Reports", summary: "Risk assessment report, top risks (CSV)", auth: "session" },

  { method: "get", path: "/import", tag: "Import", summary: "List importable entities (ADMIN only)", auth: "session" , response: importEntityListResponseSchema },
  { method: "get", path: "/import/{entity}/template", tag: "Import", summary: "Download a CSV or (?format=xlsx) XLSX template (ADMIN only)", auth: "session", params: entityParam, query: templateFormatQuery },
  { method: "post", path: "/import/{entity}/validate", tag: "Import", summary: "Validate a CSV or XLSX upload without committing (ADMIN only)", auth: "session", params: entityParam , response: importReportResponseSchema },
  { method: "post", path: "/import/{entity}", tag: "Import", summary: "Import a CSV or XLSX upload (ADMIN only)", auth: "session", params: entityParam , response: importReportResponseSchema },

  { method: "get", path: "/api-keys", tag: "Ingest", summary: "List ingestion API keys (ADMIN only)", auth: "session" , response: apiKeyListResponseSchema },
  { method: "post", path: "/api-keys", tag: "Ingest", summary: "Create an ingestion API key, secret shown once (ADMIN only)", auth: "session" , response: apiKeyCreatedResponseSchema },
  { method: "post", path: "/api-keys/{id}/revoke", tag: "Ingest", summary: "Revoke an ingestion API key (ADMIN only)", auth: "session", params: apiKeys.idParam , response: apiKeyRevokedResponseSchema },
  { method: "post", path: "/ingest/{recordType}", tag: "Ingest", summary: "Ingest JSON rows (X-API-Key header, not a session)", auth: "public", params: recordTypeParam , response: ingestResultResponseSchema },

  { method: "get", path: "/notifications", tag: "Notifications", summary: "List notifications", auth: "session" , response: notificationListResponseSchema },
  { method: "get", path: "/notifications/unread-count", tag: "Notifications", summary: "Unread count", auth: "session" , response: unreadCountResponseSchema },
  { method: "post", path: "/notifications/{id}/read", tag: "Notifications", summary: "Mark one read", auth: "session", params: notifications.idParam , response: notificationActionResponseSchema },
  { method: "post", path: "/notifications/read-all", tag: "Notifications", summary: "Mark all read", auth: "session" , response: notificationActionResponseSchema },

  { method: "get", path: "/phi-inventory", tag: "PHI Inventory", summary: "PHI categories, holding systems, and volumes", auth: "session" , response: phiInventoryResponseSchema },
  { method: "get", path: "/phi-types", tag: "PHI Inventory", summary: "List PHI types", auth: "session" , response: phiTypeListResponseSchema },
  { method: "get", path: "/phi-types/{id}", tag: "PHI Inventory", summary: "Get a PHI type", auth: "session", params: phiTypes.idParam , response: phiTypeDetailResponseSchema },
  { method: "post", path: "/phi-types", tag: "PHI Inventory", summary: "Create a PHI type (ADMIN only)", auth: "session", body: phiTypes.createBody , response: rawPhiTypeResponseSchema },
  { method: "patch", path: "/phi-types/{id}", tag: "PHI Inventory", summary: "Update a PHI type (ADMIN only)", auth: "session", params: phiTypes.idParam, body: phiTypes.patchBody , response: rawPhiTypeResponseSchema },
];

function schemaRef(schema: ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

function toOpenApiPath(path: string) {
  // {id} already matches OpenAPI's placeholder syntax; nothing to convert.
  return path;
}

function buildPaths() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const openApiPath = `/api${toOpenApiPath(route.path)}`;
    paths[openApiPath] ??= {};
    const parameters: unknown[] = [];

    if (route.params) {
      const shape = (route.params as unknown as { shape?: Record<string, ZodType> }).shape ?? {};
      for (const name of Object.keys(shape)) {
        parameters.push({ name, in: "path", required: true, schema: schemaRef(shape[name] as ZodType) });
      }
    }
    if (route.query) {
      const shape = (route.query as unknown as { shape?: Record<string, ZodType> }).shape ?? {};
      for (const name of Object.keys(shape)) {
        parameters.push({ name, in: "query", required: false, schema: schemaRef(shape[name] as ZodType) });
      }
    }

    paths[openApiPath][route.method] = {
      tags: [route.tag],
      summary: route.summary,
      security: route.auth === "public" ? [] : [{ sessionCookie: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? { requestBody: { required: true, content: { "application/json": { schema: schemaRef(route.body) } } } }
        : {}),
      responses: {
        "200": route.response
          ? { description: "Success", content: { "application/json": { schema: schemaRef(route.response) } } }
          : { description: "Success" },
        "400": { description: "Validation error" },
        "401": { description: "Not authenticated" },
        "403": { description: "Not permitted" },
        "404": { description: "Not found (including cross-tenant access)" },
      },
    };
  }
  return paths;
}

export function buildDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Drishti API",
      version: "0.3.0",
      description:
        "Healthcare PHI risk intelligence platform API. Generated from the Zod " +
        "schemas that validate every route — see scripts/generate-openapi.ts.",
    },
    // Root, not "/api": every path key below already includes the /api
    // prefix (buildPaths() builds them as `/api${route.path}`), so a
    // servers.url of "/api" too would make any spec-compliant client
    // resolve a doubled /api/api/... — exactly what happened the first
    // time this spec was actually fed to a real OpenAPI consumer (ZAP's
    // openapi job; see security/zap/automation-plan.yaml's history).
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "drishti_access",
          description: "httpOnly access-token cookie set by POST /api/auth/login",
        },
      },
    },
    paths: buildPaths(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const document = buildDocument();
  writeFileSync("openapi.json", JSON.stringify(document, null, 2) + "\n");
  console.log(`[openapi] wrote openapi.json — ${Object.keys(document.paths).length} paths`);
}
