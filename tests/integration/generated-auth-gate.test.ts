import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor } from "../helpers.js";

/**
 * Generated, 100%-of-routes coverage for the baseline auth gate, driven off
 * docs/engineering/ROUTE_INVENTORY.md rather than a hand-picked sample —
 * tests/route-inventory.test.ts already guarantees that file matches the
 * live route list, so walking it here is equivalent to walking src/routes.
 *
 * Covers two things for every `/api/*` route (public ones excluded):
 *  1. No credentials at all -> 401.
 *  2. A cookie claiming to be the access token, with no Authorization header
 *     -> still 401. This is the direct regression test for the CSRF bug
 *     fixed in middleware/auth.ts's extractToken: a cookie is sent
 *     automatically on a cross-site request, so if this ever starts passing
 *     again, every mutating route is CSRF-exposed again, not just
 *     refresh/logout.
 *
 * Path params are filled with a placeholder id that is guaranteed not to
 * belong to this request's organization (or to exist at all for most
 * resources), which is fine: the auth gate runs before any handler logic, so
 * these must 401 regardless of what the placeholder resolves to.
 */

const PUBLIC_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/accept-invite",
  "POST /api/auth/forgot-password",
  "POST /api/auth/reset-password",
]);

// Also authenticated via their own mechanism, not requireAuth's Bearer/cookie
// gate, so they don't belong in this sweep.
const SKIP_ROUTES = new Set([
  "POST /api/auth/refresh", // refresh-cookie-authenticated, exercised in session.test.ts
  "POST /api/auth/logout", // same
  "POST /api/ingest/:recordType", // X-API-Key authenticated, exercised in api-key-scope.test.ts
]);

function parseInventory(): Array<{ method: string; path: string }> {
  const doc = readFileSync(join(import.meta.dirname, "../../docs/engineering/ROUTE_INVENTORY.md"), "utf8");
  const routes: Array<{ method: string; path: string }> = [];
  const re = /^\| (GET|POST|PATCH|PUT|DELETE) \| `([^`]+)` \|/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(doc))) {
    if (match[2]!.startsWith("/health")) continue;
    const key = `${match[1]!} ${match[2]!}`;
    if (PUBLIC_ROUTES.has(key) || SKIP_ROUTES.has(key)) continue;
    routes.push({ method: match[1]!, path: match[2]! });
  }
  return routes;
}

function concretePath(path: string): string {
  return path.replace(/:[a-zA-Z]+/g, "999999");
}

const ROUTES = parseInventory();
const app = createApp();
let adminToken: string;

beforeAll(async () => {
  await seedFixture();
  // One login for the whole file, not one per test (114 routes x 2 checks
  // would otherwise be 228 logins) — the token's validity is identical
  // across every check here, so there is nothing to gain from a fresh one.
  adminToken = await tokenFor(request(app), "admin@test.local");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(ROUTES)("auth gate: $method $path", ({ method, path }) => {
  const url = concretePath(path);
  const verb = method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete";

  it("401s with no credentials at all", async () => {
    const res = await request(app)[verb](url);
    expect(res.status).toBe(401);
  });

  it("401s with only a forged access-token cookie, no Authorization header", async () => {
    const res = await request(app)[verb](url).set("Cookie", `drishti_token=${adminToken}`);
    expect(res.status).toBe(401);
  });
});
