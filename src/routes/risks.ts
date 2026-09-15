import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { listRisks } from "../services/riskService.js";
import { recomputeAssetRisk } from "../services/riskEngine.js";

export const risksRouter = Router();

const assetIdParam = z.object({ assetId: z.coerce.number().int().positive() });

/**
 * Recompute persists a new score and band, so it is a write and gated like
 * one -- same two roles as its vendor twin in routes/vendors.ts. Reading
 * risks stays open to any signed-in role.
 */
const canWrite = requireRole(["ADMIN", "ANALYST"]);

risksRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listRisks() });
  } catch (err) {
    next(err);
  }
});

risksRouter.post(
  "/:assetId/recompute",
  canWrite,
  validate({ params: assetIdParam }),
  async (req, res, next) => {
    try {
      const { assetId } = assetIdParam.parse(req.params);
      res.json({ data: await recomputeAssetRisk(assetId) });
    } catch (err) {
      next(err);
    }
  },
);
