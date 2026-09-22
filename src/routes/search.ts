import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf } from "../middleware/auth.js";
import { ok } from "../lib/http.js";
import { MIN_QUERY_LENGTH, globalSearch, type SearchType } from "../services/searchService.js";

export const searchRouter = Router();

const TYPES = ["asset", "vendor", "identity", "threat", "remediation", "control", "policy"] as const;

const searchQuery = z.object({
  q: z.string().trim().min(MIN_QUERY_LENGTH, `Query must be at least ${MIN_QUERY_LENGTH} characters`).max(120),
  /** Comma-separated subset, e.g. `types=asset,vendor`. */
  types: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

searchRouter.get("/", validate({ query: searchQuery }), async (req, res, next) => {
  try {
    const q = searchQuery.parse(req.query);

    const types = q.types
      ?.split(",")
      .map((t) => t.trim())
      .filter((t): t is SearchType => (TYPES as readonly string[]).includes(t));

    ok(
      res,
      await globalSearch(ctxOf(req), q.q, {
        ...(types && types.length > 0 ? { types } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      }),
    );
  } catch (err) {
    next(err);
  }
});
