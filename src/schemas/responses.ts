import { z } from "zod";

/**
 * Response-body schemas, separate from the request-validation schemas that
 * already live next to each route. These exist for two consumers: the
 * OpenAPI generator (scripts/generate-openapi.ts) and live contract tests
 * (tests/integration/openapi-response-contract.test.ts) that parse a real
 * HTTP response against the same schema the spec advertises.
 *
 * Scope: this is a proof of the pattern for one representative route
 * (GET /api/assets), not full coverage of all ~97 routes — see
 * docs/engineering/VERIFICATION.md for why, and what extending it to the
 * rest of the API would mechanically look like.
 */

export const riskSummarySchema = z
  .object({
    score: z.number(),
    band: z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL", "EXTREME"]),
    computedAt: z.string(),
  })
  .nullable();

export const assetListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.enum(["EHR", "DATABASE", "API", "CLOUD_STORAGE", "ANALYTICS", "OTHER"]),
  phiVolume: z.number().int(),
  encrypted: z.boolean(),
  mfaEnabled: z.boolean(),
  lastAssessedAt: z.string().nullable(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  risk: riskSummarySchema,
  counts: z.object({
    phiTypes: z.number().int(),
    flows: z.number().int(),
    accessGrants: z.number().int(),
    openThreats: z.number().int(),
    controls: z.number().int(),
  }),
});

export const pageMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

export const assetListResponseSchema = z.object({
  data: z.array(assetListItemSchema),
  meta: pageMetaSchema,
});
