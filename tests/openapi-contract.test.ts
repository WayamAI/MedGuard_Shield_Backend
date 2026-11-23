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
});
