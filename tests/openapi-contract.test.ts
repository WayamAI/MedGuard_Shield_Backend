import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildDocument } from "../scripts/generate-openapi.js";

/**
 * openapi.json is committed, hand-curated output (see
 * scripts/generate-openapi.ts's header comment: the path list is
 * transcribed from ROUTE_INVENTORY.md, not derived from it automatically).
 * This is the contract check the plan called for: fail the build the moment
 * a route's Zod schema changes, or a route is added to ROUTES, without
 * `npm run openapi:generate` having been re-run and the result committed.
 */
describe("openapi.json matches what the generator would produce right now", () => {
  it("is byte-for-byte the committed generator output", () => {
    const committed = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../openapi.json"), "utf8");
    const fresh = JSON.stringify(buildDocument(), null, 2) + "\n";
    expect(fresh, "run `npm run openapi:generate` and commit the result").toBe(committed);
  });

  /**
   * Regression for a real bug a ZAP CI run caught: several ROUTES entries
   * had a `{param}` in their path but no `params:` schema, so buildPaths()
   * never emitted a matching `parameters` entry — an OpenAPI document that
   * ZAP's own openapi job (correctly) refuses to import, since OpenAPI 3.1
   * requires every path placeholder to be declared somewhere.
   */
  it("declares a path-level parameter for every {placeholder} in every path", () => {
    const document = buildDocument() as { paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>> };
    const problems: string[] = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      const declaredInPath = new Set([...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
      for (const [method, op] of Object.entries(methods)) {
        const paramsHere = new Set((op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name));
        for (const name of declaredInPath) {
          if (!paramsHere.has(name)) problems.push(`${method.toUpperCase()} ${path}: missing path param "${name}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * Regression for a real bug the first real ZAP CI run caught: servers[0]
   * was "/api", and every path key already starts with "/api" too (buildPaths
   * builds them as `/api${route.path}`) — any spec-compliant client resolves
   * server.url + path, so that doubled every single request to
   * /api/api/..., which 404s. Confirmed live: ZAP's own scan reported 100%
   * of responses as 4xx before this was fixed. The root must be relative
   * (not also "/api"), since the paths already carry the full prefix.
   */
  it("does not double the /api prefix between servers[0].url and the paths", () => {
    const document = buildDocument() as { servers: Array<{ url: string }>; paths: Record<string, unknown> };
    expect(document.servers[0]?.url).not.toMatch(/\/api/);
    expect(Object.keys(document.paths).every((p) => p.startsWith("/api/"))).toBe(true);
  });
});
