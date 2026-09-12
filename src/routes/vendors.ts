import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import {
  createVendor, getVendorById, listVendors, recomputeVendorRisk, updateVendor,
} from "../services/vendorService.js";

export const vendorsRouter = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });
const BAA_STATUSES = ["SIGNED", "PENDING", "EXPIRED", "MISSING"] as const;

const createBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  baaStatus: z.enum(BAA_STATUSES).optional(),
  phiVolume: z.number().int().min(0).optional(),
  lastAssessedAt: z.coerce.date().nullable().optional(),
});

const patchBody = createBody.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to update" },
);

const canWrite = requireRole(["ADMIN", "ANALYST"]);

vendorsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listVendors() });
  } catch (err) {
    next(err);
  }
});

vendorsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    res.json({ data: await getVendorById(id) });
  } catch (err) {
    next(err);
  }
});

vendorsRouter.post("/", canWrite, validate({ body: createBody }), async (req, res, next) => {
  try {
    res.status(201).json({ data: await createVendor(createBody.parse(req.body)) });
  } catch (err) {
    next(err);
  }
});

vendorsRouter.patch(
  "/:id", canWrite, validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      res.json({ data: await updateVendor(id, patchBody.parse(req.body)) });
    } catch (err) {
      next(err);
    }
  },
);

vendorsRouter.post(
  "/:id/recompute", canWrite, validate({ params: idParam }),
  async (req, res, next) => {
    try {
      const { id } = idParam.parse(req.params);
      res.json({ data: await recomputeVendorRisk(id) });
    } catch (err) {
      next(err);
    }
  },
);
