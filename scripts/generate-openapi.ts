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
import * as assets from "../src/routes/assets.js";
import * as auth from "../src/routes/auth.js";
import * as controls from "../src/routes/controls.js";
import * as dataflows from "../src/routes/dataflows.js";
import * as identities from "../src/routes/identities.js";
import * as organization from "../src/routes/organization.js";
import * as phiTypes from "../src/routes/phiInventory.js";
import * as policies from "../src/routes/policies.js";
import * as remediations from "../src/routes/remediations.js";
import * as risks from "../src/routes/risks.js";
import * as search from "../src/routes/search.js";
import * as threats from "../src/routes/threats.js";
import * as vendors from "../src/routes/vendors.js";
import { paginationQuery } from "../src/lib/pagination.js";
import { assetListResponseSchema } from "../src/schemas/responses.js";

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

const ROUTES: RouteSpec[] = [
  { method: "post", path: "/auth/login", tag: "Auth", summary: "Log in (may require a second call with mfaCode)", auth: "public", body: auth.loginBody },
  { method: "post", path: "/auth/refresh", tag: "Auth", summary: "Rotate the refresh token", auth: "session" },
  { method: "post", path: "/auth/logout", tag: "Auth", summary: "Log out this session", auth: "session" },
  { method: "post", path: "/auth/logout-all", tag: "Auth", summary: "Revoke every session", auth: "session" },
  { method: "get", path: "/auth/me", tag: "Auth", summary: "Current user", auth: "session" },
  { method: "post", path: "/auth/accept-invite", tag: "Auth", summary: "Accept an invite and set a password", auth: "public" },
  { method: "post", path: "/auth/forgot-password", tag: "Auth", summary: "Request a password reset email", auth: "public" },
  { method: "post", path: "/auth/reset-password", tag: "Auth", summary: "Reset password with a mailed token", auth: "public" },
  { method: "post", path: "/auth/change-password", tag: "Auth", summary: "Change password (requires current)", auth: "session" },
  { method: "post", path: "/auth/mfa/enroll", tag: "Auth", summary: "Start TOTP enrollment", auth: "session" },
  { method: "post", path: "/auth/mfa/confirm", tag: "Auth", summary: "Confirm enrollment, receive recovery codes", auth: "session" },
  { method: "post", path: "/auth/mfa/disable", tag: "Auth", summary: "Disable MFA (password + code)", auth: "session" },
  { method: "get", path: "/auth/sessions", tag: "Auth", summary: "List active sessions", auth: "session" },
  { method: "post", path: "/auth/sessions/{id}/revoke", tag: "Auth", summary: "Revoke one session", auth: "session" },
  { method: "post", path: "/auth/sessions/revoke-others", tag: "Auth", summary: "Revoke every other session", auth: "session" },

  { method: "get", path: "/members", tag: "Members", summary: "List organization members", auth: "session" },
  { method: "post", path: "/members/invites", tag: "Members", summary: "Invite a member (ADMIN only)", auth: "session" },
  { method: "post", path: "/members/invites/{inviteId}/resend", tag: "Members", summary: "Resend an invite (ADMIN only)", auth: "session" },
  { method: "delete", path: "/members/invites/{inviteId}", tag: "Members", summary: "Revoke an invite (ADMIN only)", auth: "session" },
  { method: "patch", path: "/members/{userId}/role", tag: "Members", summary: "Change a member's role (ADMIN only)", auth: "session" },
  { method: "post", path: "/members/{userId}/deactivate", tag: "Members", summary: "Deactivate a member (ADMIN only)", auth: "session" },
  { method: "post", path: "/members/{userId}/reactivate", tag: "Members", summary: "Reactivate a member (ADMIN only)", auth: "session" },

  { method: "get", path: "/organization", tag: "Organization", summary: "Current organization", auth: "session" },
  { method: "get", path: "/organization/members", tag: "Organization", summary: "List members", auth: "session" },
  { method: "get", path: "/organization/settings", tag: "Organization", summary: "Configurable thresholds", auth: "session" },
  { method: "patch", path: "/organization/settings", tag: "Organization", summary: "Update thresholds (ADMIN only)", auth: "session", body: organization.settingsBody },

  { method: "get", path: "/assets", tag: "Assets", summary: "List assets", auth: "session", query: assets.listQuery, response: assetListResponseSchema },
  { method: "get", path: "/assets/{id}", tag: "Assets", summary: "Get an asset", auth: "session", params: assets.idParam },
  { method: "post", path: "/assets", tag: "Assets", summary: "Create an asset", auth: "session", body: assets.createBody },
  { method: "patch", path: "/assets/{id}", tag: "Assets", summary: "Update an asset", auth: "session", params: assets.idParam, body: assets.patchBody },
  { method: "post", path: "/assets/{id}/archive", tag: "Assets", summary: "Archive an asset", auth: "session", params: assets.idParam },
  { method: "post", path: "/assets/{id}/restore", tag: "Assets", summary: "Restore an asset", auth: "session", params: assets.idParam },
  { method: "post", path: "/assets/{id}/assessment", tag: "Assets", summary: "Record a risk assessment", auth: "session", params: assets.idParam, body: assets.assessmentBody },
  { method: "post", path: "/assets/{id}/recompute", tag: "Assets", summary: "Recompute risk", auth: "session", params: assets.idParam },
  { method: "get", path: "/assets/{id}/risk-history", tag: "Assets", summary: "Risk history", auth: "session", params: assets.idParam, query: paginationQuery },
  { method: "get", path: "/assets/{id}/history", tag: "Assets", summary: "Audit history", auth: "session", params: assets.idParam, query: paginationQuery },
  { method: "get", path: "/assets/{id}/control-evidence", tag: "Assets", summary: "Control evidence", auth: "session", params: assets.idParam },
  { method: "put", path: "/assets/{id}/controls/{controlId}", tag: "Assets", summary: "Link a control", auth: "session", params: assets.controlLinkParams },
  { method: "delete", path: "/assets/{id}/controls/{controlId}", tag: "Assets", summary: "Unlink a control", auth: "session", params: assets.controlLinkParams },

  { method: "get", path: "/dataflows", tag: "DataFlows", summary: "List data flows", auth: "session", query: dataflows.listQuery },
  { method: "get", path: "/dataflows/{id}", tag: "DataFlows", summary: "Get a data flow", auth: "session", params: dataflows.idParam },

  { method: "get", path: "/risks", tag: "Risks", summary: "List risks", auth: "session", query: risks.listQuery },
  { method: "get", path: "/risks/distribution", tag: "Risks", summary: "Risk band distribution", auth: "session" },
  { method: "get", path: "/risks/history", tag: "Risks", summary: "Risk history", auth: "session", query: risks.historyQuery },
  { method: "post", path: "/risks/{assetId}/recompute", tag: "Risks", summary: "Recompute an asset's risk", auth: "session", params: risks.assetIdParam },

  { method: "get", path: "/vendors", tag: "Vendors", summary: "List vendors", auth: "session", query: vendors.listQuery },
  { method: "get", path: "/vendors/{id}", tag: "Vendors", summary: "Get a vendor", auth: "session", params: vendors.idParam },
  { method: "post", path: "/vendors", tag: "Vendors", summary: "Create a vendor", auth: "session", body: vendors.createBody },
  { method: "patch", path: "/vendors/{id}", tag: "Vendors", summary: "Update a vendor", auth: "session", params: vendors.idParam, body: vendors.patchBody },
  { method: "post", path: "/vendors/{id}/archive", tag: "Vendors", summary: "Archive a vendor", auth: "session", params: vendors.idParam },
  { method: "post", path: "/vendors/{id}/restore", tag: "Vendors", summary: "Restore a vendor", auth: "session", params: vendors.idParam },
  { method: "post", path: "/vendors/{id}/assessment", tag: "Vendors", summary: "Record a risk assessment", auth: "session", params: vendors.idParam, body: vendors.assessmentBody },
  { method: "post", path: "/vendors/{id}/recompute", tag: "Vendors", summary: "Recompute risk", auth: "session", params: vendors.idParam },
  { method: "put", path: "/vendors/{id}/assets/{assetId}", tag: "Vendors", summary: "Link an asset", auth: "session", params: vendors.assetLinkParams },
  { method: "delete", path: "/vendors/{id}/assets/{assetId}", tag: "Vendors", summary: "Unlink an asset", auth: "session", params: vendors.assetLinkParams },
  { method: "get", path: "/vendors/{id}/risk-history", tag: "Vendors", summary: "Risk history", auth: "session", params: vendors.idParam, query: paginationQuery },
  { method: "get", path: "/vendors/{id}/history", tag: "Vendors", summary: "Audit history", auth: "session", params: vendors.idParam, query: paginationQuery },

  { method: "get", path: "/identities", tag: "Identities", summary: "List identities", auth: "session", query: identities.listQuery },
  { method: "get", path: "/identities/{id}", tag: "Identities", summary: "Get an identity", auth: "session", params: identities.idParam },
  { method: "post", path: "/identities", tag: "Identities", summary: "Create an identity", auth: "session", body: identities.createBody },
  { method: "patch", path: "/identities/{id}", tag: "Identities", summary: "Update an identity", auth: "session", params: identities.idParam, body: identities.patchBody },
  { method: "post", path: "/identities/{id}/archive", tag: "Identities", summary: "Archive an identity", auth: "session", params: identities.idParam },

  { method: "get", path: "/access", tag: "Access", summary: "List access grants", auth: "session", query: access.listQuery },
  { method: "get", path: "/access/summary", tag: "Access", summary: "Access summary", auth: "session" },
  { method: "get", path: "/access/{id}", tag: "Access", summary: "Get an access grant", auth: "session", params: access.idParam },
  { method: "post", path: "/access", tag: "Access", summary: "Grant access", auth: "session", body: access.grantBody },
  { method: "patch", path: "/access/{id}", tag: "Access", summary: "Update a grant", auth: "session", params: access.idParam, body: access.patchBody },
  { method: "post", path: "/access/{id}/revoke", tag: "Access", summary: "Revoke a grant", auth: "session", params: access.idParam },
  { method: "post", path: "/access/{id}/review", tag: "Access", summary: "Review a grant", auth: "session", params: access.idParam },

  { method: "get", path: "/threats", tag: "Threats", summary: "List threats", auth: "session", query: threats.listQuery },
  { method: "get", path: "/threats/summary", tag: "Threats", summary: "Threats summary", auth: "session" },
  { method: "get", path: "/threats/{id}", tag: "Threats", summary: "Get a threat", auth: "session", params: threats.idParam },
  { method: "post", path: "/threats", tag: "Threats", summary: "Create a threat", auth: "session", body: threats.createBody },
  { method: "patch", path: "/threats/{id}", tag: "Threats", summary: "Update a threat", auth: "session", params: threats.idParam, body: threats.patchBody },
  { method: "post", path: "/threats/{id}/status", tag: "Threats", summary: "Transition status", auth: "session", params: threats.idParam, body: threats.transitionBody },
  { method: "get", path: "/threats/{id}/history", tag: "Threats", summary: "Audit history", auth: "session", params: threats.idParam, query: paginationQuery },

  { method: "get", path: "/controls", tag: "Controls", summary: "List controls", auth: "session", query: controls.listQuery },
  { method: "get", path: "/controls/{id}", tag: "Controls", summary: "Get a control", auth: "session", params: controls.idParam },
  { method: "post", path: "/controls", tag: "Controls", summary: "Create a control", auth: "session", body: controls.createBody },
  { method: "patch", path: "/controls/{id}", tag: "Controls", summary: "Update or assess a control", auth: "session", params: controls.idParam, body: controls.patchBody },
  { method: "post", path: "/controls/{id}/archive", tag: "Controls", summary: "Archive a control", auth: "session", params: controls.idParam },
  { method: "put", path: "/controls/{id}/assets/{assetId}", tag: "Controls", summary: "Link an asset", auth: "session", params: controls.linkParams },
  { method: "delete", path: "/controls/{id}/assets/{assetId}", tag: "Controls", summary: "Unlink an asset", auth: "session", params: controls.linkParams },

  { method: "get", path: "/policies", tag: "Policies", summary: "List policies", auth: "session", query: policies.listQuery },
  { method: "get", path: "/policies/{id}", tag: "Policies", summary: "Get a policy", auth: "session", params: policies.idParam },
  { method: "post", path: "/policies", tag: "Policies", summary: "Create a policy", auth: "session", body: policies.createBody },
  { method: "patch", path: "/policies/{id}", tag: "Policies", summary: "Update a policy", auth: "session", params: policies.idParam, body: policies.patchBody },
  { method: "post", path: "/policies/{id}/archive", tag: "Policies", summary: "Archive a policy", auth: "session", params: policies.idParam },
  { method: "put", path: "/policies/{id}/controls/{controlId}", tag: "Policies", summary: "Link a control", auth: "session", params: policies.linkParams },
  { method: "delete", path: "/policies/{id}/controls/{controlId}", tag: "Policies", summary: "Unlink a control", auth: "session", params: policies.linkParams },

  { method: "get", path: "/remediations", tag: "Remediations", summary: "List remediations", auth: "session", query: remediations.listQuery },
  { method: "get", path: "/remediations/summary", tag: "Remediations", summary: "Remediations summary", auth: "session" },
  { method: "get", path: "/remediations/{id}", tag: "Remediations", summary: "Get a remediation", auth: "session", params: remediations.idParam },
  { method: "post", path: "/remediations", tag: "Remediations", summary: "Create a remediation", auth: "session", body: remediations.createBody },
  { method: "patch", path: "/remediations/{id}", tag: "Remediations", summary: "Update a remediation", auth: "session", params: remediations.idParam, body: remediations.patchBody },
  { method: "post", path: "/remediations/{id}/status", tag: "Remediations", summary: "Transition status", auth: "session", params: remediations.idParam, body: remediations.transitionBody },
  { method: "post", path: "/remediations/{id}/assign", tag: "Remediations", summary: "Assign an owner", auth: "session", params: remediations.idParam, body: remediations.assignBody },
  { method: "get", path: "/remediations/{id}/history", tag: "Remediations", summary: "Audit history", auth: "session", params: remediations.idParam, query: paginationQuery },

  { method: "get", path: "/audit", tag: "Audit", summary: "List audit events (ADMIN only)", auth: "session" },
  { method: "get", path: "/audit/verify", tag: "Audit", summary: "Verify the hash chain's integrity (ADMIN only)", auth: "session" },

  { method: "get", path: "/search", tag: "Search", summary: "Global search", auth: "session", query: search.searchQuery },

  { method: "get", path: "/reports/risk-assessment", tag: "Reports", summary: "Risk assessment report (JSON)", auth: "session" },
  { method: "get", path: "/reports/risk-assessment.pdf", tag: "Reports", summary: "Risk assessment report (PDF)", auth: "session" },
  { method: "get", path: "/reports/risk-assessment.csv", tag: "Reports", summary: "Risk assessment report, top risks (CSV)", auth: "session" },

  { method: "get", path: "/import", tag: "Import", summary: "List importable entities (ADMIN only)", auth: "session" },
  { method: "get", path: "/import/{entity}/template", tag: "Import", summary: "Download a CSV template (ADMIN only)", auth: "session" },
  { method: "post", path: "/import/{entity}/validate", tag: "Import", summary: "Validate a CSV without committing (ADMIN only)", auth: "session" },
  { method: "post", path: "/import/{entity}", tag: "Import", summary: "Import a CSV (ADMIN only)", auth: "session" },

  { method: "get", path: "/api-keys", tag: "Ingest", summary: "List ingestion API keys (ADMIN only)", auth: "session" },
  { method: "post", path: "/api-keys", tag: "Ingest", summary: "Create an ingestion API key, secret shown once (ADMIN only)", auth: "session" },
  { method: "post", path: "/api-keys/{id}/revoke", tag: "Ingest", summary: "Revoke an ingestion API key (ADMIN only)", auth: "session" },
  { method: "post", path: "/ingest/{recordType}", tag: "Ingest", summary: "Ingest JSON rows (X-API-Key header, not a session)", auth: "public" },

  { method: "get", path: "/notifications", tag: "Notifications", summary: "List notifications", auth: "session" },
  { method: "get", path: "/notifications/unread-count", tag: "Notifications", summary: "Unread count", auth: "session" },
  { method: "post", path: "/notifications/{id}/read", tag: "Notifications", summary: "Mark one read", auth: "session" },
  { method: "post", path: "/notifications/read-all", tag: "Notifications", summary: "Mark all read", auth: "session" },

  { method: "get", path: "/phi-inventory", tag: "PHI Inventory", summary: "PHI categories, holding systems, and volumes", auth: "session" },
  { method: "get", path: "/phi-types", tag: "PHI Inventory", summary: "List PHI types", auth: "session" },
  { method: "get", path: "/phi-types/{id}", tag: "PHI Inventory", summary: "Get a PHI type", auth: "session", params: phiTypes.idParam },
  { method: "post", path: "/phi-types", tag: "PHI Inventory", summary: "Create a PHI type (ADMIN only)", auth: "session", body: phiTypes.createBody },
  { method: "patch", path: "/phi-types/{id}", tag: "PHI Inventory", summary: "Update a PHI type (ADMIN only)", auth: "session", params: phiTypes.idParam, body: phiTypes.patchBody },
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
    servers: [{ url: "/api" }],
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
