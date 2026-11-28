import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Turns the manual claim in docs/engineering/SECURITY_REVIEW.md ("every one
 * of the 47 mutating handlers has a matching recordAudit/recordAuthEventSafe
 * call ... confirmed by a mutation-count vs audit-call-count diff per file")
 * into an enforced, re-runnable check instead of a one-time hand count.
 *
 * For every route docs/engineering/ROUTE_INVENTORY.md marks "Audited: yes",
 * confirms an audit call (`recordAudit(`, `recordAuditSafe(`, or
 * `recordAuthEventSafe(`) exists somewhere in that route's file or the
 * service file(s) it's known to delegate to. This is file-level, not
 * handler-span-level, so it cannot catch "the WRONG handler in this file is
 * audited and this one isn't" — but it does catch the gross failure mode of
 * a route documented as audited that calls no audit function anywhere on
 * its path, which is the failure mode that actually matters (a mutation
 * nobody ever logs).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_CALL = /recordAudit\(|recordAuditSafe\(|recordAuthEventSafe\(/;

// Explicit, not inferred: route file -> every service file whose code it is
// known to call into for mutations, read off each router's imports.
const ROUTE_TO_SERVICE_FILES: Record<string, string[]> = {
  "access.ts": ["accessService.ts"],
  "apiKeys.ts": ["apiKeyService.ts"],
  "assets.ts": ["assetService.ts"],
  "audit.ts": ["auditQueryService.ts", "auditService.ts"],
  "auth.ts": ["authService.ts", "passwordResetService.ts", "mfaService.ts", "memberService.ts"],
  "controls.ts": ["controlService.ts"],
  "dataflows.ts": ["dataFlowService.ts"],
  "identities.ts": ["identityService.ts"],
  "import.ts": ["importService.ts"],
  "ingest.ts": ["importService.ts"],
  "members.ts": ["memberService.ts"],
  "notifications.ts": ["notificationService.ts"],
  "organization.ts": ["orgSettingsService.ts"],
  "phiInventory.ts": ["phiInventoryService.ts"],
  "policies.ts": ["policyService.ts"],
  "remediations.ts": ["remediationService.ts"],
  "reports.ts": ["reportService.ts", "reportPdf.ts"],
  "risks.ts": ["riskService.ts", "riskEngine.ts"],
  "search.ts": ["searchService.ts"],
  "threats.ts": ["threatService.ts"],
  "vendors.ts": ["vendorService.ts"],
};

function fileHasAuditCall(relativePath: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- relativePath always comes from the fixed maps above, never request/user input
  const src = readFileSync(join(root, relativePath), "utf8");
  return AUDIT_CALL.test(src);
}

function routeFileFromPath(apiPath: string): string {
  // "/api/phi-types/:id" -> "phiInventory.ts" (two routers share one file);
  // every other first segment maps 1:1 to its router's filename.
  const segment = apiPath.split("/")[2];
  if (segment === "phi-types" || segment === "phi-inventory") return "phiInventory.ts";
  if (segment === "api-keys") return "apiKeys.ts";
  return `${segment}.ts`;
}

function auditedMutatingRoutes(): Array<{ method: string; path: string }> {
  const doc = readFileSync(join(root, "docs/engineering/ROUTE_INVENTORY.md"), "utf8");
  const rows: Array<{ method: string; path: string }> = [];
  const re = /^\| (POST|PATCH|PUT|DELETE) \| `([^`]+)` \| [^|]+ \| [^|]+ \| (yes[^|]*) \|/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(doc))) {
    rows.push({ method: match[1]!, path: match[2]! });
  }
  return rows;
}

describe.each(auditedMutatingRoutes())(
  "audit coverage: $method $path is documented as audited",
  ({ path }) => {
    it("has a matching audit call in its route file or a service it delegates to", () => {
      const routeFile = routeFileFromPath(path);
      const candidates = [`src/routes/${routeFile}`, ...(ROUTE_TO_SERVICE_FILES[routeFile] ?? []).map((f) => `src/services/${f}`)];
      const hasAuditCall = candidates.some(fileHasAuditCall);
      expect(hasAuditCall, `expected one of ${candidates.join(", ")} to call recordAudit/recordAuthEventSafe`).toBe(true);
    });
  },
);
