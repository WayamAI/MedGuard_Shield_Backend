import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Catches route-inventory drift: a new or renamed route added to
 * src/routes/*.ts that nobody added to docs/engineering/ROUTE_INVENTORY.md
 * (the file the RBAC/tenancy/audit coverage claims live in) fails this test
 * instead of silently shipping undocumented. It does not re-verify the
 * permission/org-scoped/audited/test-coverage columns themselves — that
 * would require re-deriving them from the handler bodies, which the
 * inventory's own regeneration instructions already do by hand.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROUTER_PREFIXES: Record<string, string> = {
  "access.ts": "/api/access",
  "assets.ts": "/api/assets",
  "audit.ts": "/api/audit",
  "auth.ts": "/api/auth",
  "controls.ts": "/api/controls",
  "dataflows.ts": "/api/dataflows",
  "identities.ts": "/api/identities",
  "import.ts": "/api/import",
  "ingest.ts": "/api/ingest",
  "apiKeys.ts": "/api/api-keys",
  "members.ts": "/api/members",
  "notifications.ts": "/api/notifications",
  "organization.ts": "/api/organization",
  "policies.ts": "/api/policies",
  "remediations.ts": "/api/remediations",
  "reports.ts": "/api/reports",
  "risks.ts": "/api/risks",
  "search.ts": "/api/search",
  "threats.ts": "/api/threats",
  "vendors.ts": "/api/vendors",
};

// phiInventory.ts mounts two routers at two different prefixes, keyed by
// which exported router a handler belongs to rather than by file alone.
const PHI_INVENTORY_PREFIXES: Record<string, string> = {
  phiInventoryRouter: "/api/phi-inventory",
  phiTypesRouter: "/api/phi-types",
};

function extractRoutes(file: string, prefix: string): Array<{ method: string; path: string }> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file comes from readdirSync(routesDir), not user input
  const src = readFileSync(file, "utf8");
  const routes: Array<{ method: string; path: string }> = [];
  const re = /^\w+\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]*)["'`]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const method = match[1].toUpperCase();
    const subpath = match[2];
    const path = (prefix + subpath).replace(/\/$/, "") || prefix;
    routes.push({ method, path });
  }
  return routes;
}

function extractPhiInventoryRoutes(file: string): Array<{ method: string; path: string }> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file comes from readdirSync(routesDir), not user input
  const src = readFileSync(file, "utf8");
  const routes: Array<{ method: string; path: string }> = [];
  const re = /^(\w+)\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]*)["'`]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const varName = match[1];
    const prefix = PHI_INVENTORY_PREFIXES[varName];
    if (!prefix) continue;
    const method = match[2].toUpperCase();
    const subpath = match[3];
    const path = (prefix + subpath).replace(/\/$/, "") || prefix;
    routes.push({ method, path });
  }
  return routes;
}

function liveRoutes(): Set<string> {
  const routesDir = join(root, "src/routes");
  const live = new Set<string>();
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const full = join(routesDir, file);
    const extracted =
      file === "phiInventory.ts"
        ? extractPhiInventoryRoutes(full)
        : extractRoutes(full, ROUTER_PREFIXES[file] ?? "");
    for (const { method, path } of extracted) live.add(`${method} ${path}`);
  }
  return live;
}

function documentedRoutes(): Set<string> {
  const doc = readFileSync(join(root, "docs/engineering/ROUTE_INVENTORY.md"), "utf8");
  const documented = new Set<string>();
  const re = /^\| (GET|POST|PATCH|PUT|DELETE) \| `([^`]+)` \|/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(doc))) {
    if (match[2].startsWith("/health")) continue; // not under src/routes
    documented.add(`${match[1]} ${match[2]}`);
  }
  return documented;
}

describe("route inventory stays in sync with the code", () => {
  it("documents every route actually registered in src/routes/*.ts", () => {
    const live = liveRoutes();
    const documented = documentedRoutes();
    const undocumented = [...live].filter((r) => !documented.has(r));
    expect(undocumented, "add these to docs/engineering/ROUTE_INVENTORY.md").toEqual([]);
  });

  it("documents no route that no longer exists in the code", () => {
    const live = liveRoutes();
    const documented = documentedRoutes();
    const stale = [...documented].filter((r) => !live.has(r));
    expect(stale, "remove these from docs/engineering/ROUTE_INVENTORY.md").toEqual([]);
  });
});
