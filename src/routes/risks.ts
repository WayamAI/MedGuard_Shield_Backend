import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { listRisks } from "../services/riskService.js";
import { recomputeAssetRisk } from "../services/riskEngine.js";

export const risksRouter = Router();

const assetIdParam = z.object({ assetId: z.coerce.number().int().positive() });

risksRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listRisks() });
  } catch (err) {
    next(err);
  }
});

risksRouter.post(
  "/:assetId/recompute",
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
