import type { Role } from "../generated/prisma/client.js";

/**
 * The authorization matrix, in one place.
 *
 * Routes previously carried literal role arrays — `requireRole(["ADMIN",
 * "ANALYST"])` — which made "what can an analyst actually do?" a question you
 * answered by grepping twelve files and hoping you found them all. It also
 * made every write identical: an analyst who could triage a threat could also
 * rename an asset, archive a vendor's access, or rewrite a policy.
 *
 * The distinction this encodes:
 *
 *   ADMIN    configures the estate. Creates and retires the records that
 *            describe what the organisation owns, who exists, and what the
 *            policy is.
 *
 *   ANALYST  works *within* the estate someone else configured. Assesses risk,
 *            investigates threats, drives remediation, attests to access
 *            reviews, records control effectiveness. Cannot change what the
 *            estate *is*.
 *
 *   VIEWER   reads.
 *
 * The line is "does this change the inventory, or does it change our
 * assessment of the inventory?" An analyst who can invent assets, grant
 * access, or delete the policy register is an admin with a different label.
 */

export type Permission =
  // organisation
  | "organization:read"
  // assets
  | "asset:read" | "asset:create" | "asset:update" | "asset:archive"
  | "asset:assess" | "asset:link-control"
  // vendors
  | "vendor:read" | "vendor:create" | "vendor:update" | "vendor:archive"
  | "vendor:assess" | "vendor:link-asset"
  // identities
  | "identity:read" | "identity:create" | "identity:update" | "identity:archive"
  // access
  | "access:read" | "access:grant" | "access:update" | "access:revoke" | "access:review"
  // threats
  | "threat:read" | "threat:create" | "threat:update" | "threat:transition"
  // controls
  | "control:read" | "control:create" | "control:update" | "control:assess"
  | "control:archive" | "control:link-asset"
  // policies
  | "policy:read" | "policy:create" | "policy:update" | "policy:archive"
  | "policy:link-control"
  // remediation
  | "remediation:read" | "remediation:create" | "remediation:update"
  | "remediation:transition" | "remediation:assign"
  // risk, audit, import
  | "risk:read" | "audit:read" | "import:read" | "import:execute";

/**
 * Every permission an ANALYST holds. ADMIN holds all of them plus everything
 * else; VIEWER holds only the `:read` ones.
 *
 * Expressed as the analyst's set rather than as per-permission role lists
 * because the analyst's boundary is the only one that needs arguing — the
 * other two roles are "everything" and "nothing but reads".
 */
const ANALYST_GRANTS: ReadonlySet<Permission> = new Set([
  // Risk analysis is the job.
  "asset:assess",
  "vendor:assess",

  // Investigation: an analyst raises and triages threats.
  "threat:create",
  "threat:update",
  "threat:transition",

  // Remediation is analyst-driven end to end — finding it, owning it, closing
  // it. Note that closing it records a claim and changes no inventory.
  "remediation:create",
  "remediation:update",
  "remediation:transition",
  "remediation:assign",

  // Attesting that a grant was reviewed. This records that a human looked; it
  // does not change who can reach what, which is why `access:grant`,
  // `access:update` and `access:revoke` are not here.
  "access:review",

  // Recording how well a control is working is assessment, not configuration.
  // Enforced field-by-field in routes/controls.ts: an analyst may set
  // `effectiveness`, `status` and `lastReviewedAt` and nothing else.
  "control:assess",
]);

/** Permissions that are pure reads, held by every authenticated role. */
const READ_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "organization:read", "asset:read", "vendor:read", "identity:read",
  "access:read", "threat:read", "control:read", "policy:read",
  "remediation:read", "risk:read",
  // NOT audit:read or import:read -- both are ADMIN-only. The audit trail
  // names who did what from which address, and the import contract describes
  // the shape of the estate.
]);

export function can(role: Role, permission: Permission): boolean {
  if (role === "ADMIN") return true;
  if (READ_PERMISSIONS.has(permission)) return true;
  if (role === "ANALYST") return ANALYST_GRANTS.has(permission);
  return false;
}

/** Roles that hold a permission, for the message on a 403. */
export function rolesWith(permission: Permission): Role[] {
  return (["ADMIN", "ANALYST", "VIEWER"] as const).filter((r) => can(r, permission));
}

/**
 * Control fields an ANALYST may change under `control:assess`.
 *
 * Anything outside this set is configuration and needs `control:update`.
 */
export const ANALYST_CONTROL_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "effectiveness",
  "lastReviewedAt",
]);
