import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { assetListResponseSchema } from "../../src/schemas/responses.js";
import { seedFixture, tokenFor } from "../helpers.js";

/**
 * A real response-body contract test: calls the live route and validates
 * the actual HTTP response against the same Zod schema openapi.json
 * advertises for it (scripts/generate-openapi.ts wires assetListResponseSchema
 * into GET /assets's "200" entry). This is the one route this round added a
 * response schema for — see src/schemas/responses.ts's header comment for
 * why this isn't all ~97 routes yet.
 */

const app = createApp();

beforeEach(async () => {
  await seedFixture();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/assets response matches its OpenAPI schema", () => {
  it("parses cleanly against assetListResponseSchema", async () => {
    const token = await tokenFor(request(app), "admin@test.local");
    const res = await request(app).get("/api/assets").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const result = assetListResponseSchema.safeParse(res.body);
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(true);
  });
});
