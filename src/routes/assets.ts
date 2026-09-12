import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { createAsset, getAssetById, listAssets, updateAsset } from "../services/assetService.js";

export const assetsRouter = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

const ASSET_TYPES = ["EHR", "DATABASE", "API", "CLOUD_STORAGE", "ANALYTICS", "OTHER"] as const;

const createBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  type: z.enum(ASSET_TYPES),
  phiVolume: z.number().int().min(0).optional(),
  encrypted: z.boolean().optional(),
  mfaEnabled: z.boolean().optional(),
  lastAssessedAt: z.coerce.date().nullable().optional(),
});

// Every field optional, but not an empty object -- a PATCH that changes
// nothing is a client mistake worth surfacing rather than a silent no-op.
const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);

/** Writes are restricted; reads are open to any signed-in role. */
const canWrite = requireRole(["ADMIN", "ANALYST"]);

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

assetsRouter.post("/", canWrite, validate({ body: createBody }), async (req, res, next) => {
  try {
    const asset = await createAsset(createBody.parse(req.body));
    res.status(201).json({ data: asset });
  } catch (err) {
    next(err);
  }
});

assetsRouter.patch(
  "/:id",
  canWrite,
  validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      res.json({ data: await updateAsset(id, patchBody.parse(req.body)) });
    } catch (err) {
      next(err);
    }
  },
);
