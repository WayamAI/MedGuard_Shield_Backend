import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { rolesWith, type Permission } from "../../src/lib/permissions.js";
import { seedFixture, tokenFor } from "../helpers.js";

/**
 * Generated, 100%-of-routes RBAC coverage, driven off ROUTE_INVENTORY.md's
 * own Permission column rather than a hand-picked sample — the same source
 * generated-auth-gate.test.ts and audit-coverage.test.ts already trust, and
 * which route-inventory.test.ts guarantees stays in sync with the code.
 *
 * For every route whose documented permission names a specific
 * `resource:action` string, calls it as each of the three roles and checks
 * the one thing this layer is responsible for: a role NOT in
 * rolesWith(permission) gets 403, one that IS never gets 403 (it may still
 * 404 on the placeholder id, or 400 on a body it didn't send — this test
 * only asserts on the permission gate, not on full request validity).
 *
 * Deliberately excluded, with reasons:
 *  - Routes documented "read (all roles)" or "requireAuth" with no named
 *    permission: nothing role-specific to assert (every role passes).
 *  - PATCH /api/controls/:id: field-scoped (`canPatchControl`), not a
 *    uniform per-role gate — already covered by permissions.test.ts.
 *  - POST /api/ingest/:recordType: API-key authenticated, not role-based;
 *    see api-key-scope.test.ts.
 */

const SKIP_PATHS = new Set(["PATCH /api/controls/:id", "POST /api/ingest/:recordType"]);

type Row = { method: string; path: string; permission: Permission };

function parseInventory(): Row[] {
  const doc = readFileSync(join(import.meta.dirname, "../../docs/engineering/ROUTE_INVENTORY.md"), "utf8");
  const rows: Row[] = [];
  const re = /^\| (GET|POST|PATCH|PUT|DELETE) \| `([^`]+)` \| `([a-z]+:[a-z-]+)`/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(doc))) {
    const key = `${match[1]} ${match[2]}`;
    if (SKIP_PATHS.has(key)) continue;
    rows.push({ method: match[1], path: match[2], permission: match[3] as Permission });
  }
  return rows;
}

function concretePath(path: string): string {
  return path.replace(/:[a-zA-Z]+/g, "999999");
}

const ROUTES = parseInventory();
const app = createApp();
const ROLES = ["ADMIN", "ANALYST", "VIEWER"] as const;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await seedFixture();
  for (const role of ROLES) {
    tokens[role] = await tokenFor(request(app), `${role.toLowerCase()}@test.local`);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(ROUTES)("RBAC: $method $path requires $permission", ({ method, path, permission }) => {
  const url = concretePath(path);
  const verb = method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete";
  const allowedRoles = rolesWith(permission);

  for (const role of ROLES) {
    const expectBlocked = !allowedRoles.includes(role);
    it(`${expectBlocked ? "blocks" : "does not block"} ${role}`, async () => {
      const res = await request(app)[verb](url).set("Authorization", `Bearer ${tokens[role]}`).send({});
      if (expectBlocked) {
        expect(res.status).toBe(403);
      } else {
        expect(res.status).not.toBe(403);
      }
    });
  }
});
