import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { getAssetById, listAssets } from "../services/assetService.js";

export const assetsRouter = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

assetsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listAssets() });
  } catch (err) {
    next(err);
  }
});

assetsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    res.json({ data: await getAssetById(id) });
  } catch (err) {
    next(err);
  }
});
