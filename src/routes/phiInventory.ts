import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok } from "../lib/http.js";
import { maybeSendCsv } from "../lib/csv.js";
import { diffFields, recordAudit } from "../services/auditService.js";
import {
  createPhiType, getPhiTypeById, listPhiTypes, phiInventory, updatePhiType,
} from "../services/phiInventoryService.js";

export const phiInventoryRouter = Router();
export const phiTypesRouter = Router();

const SENSITIVITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  sensitivity: z.enum(SENSITIVITIES),
});
export const patchBody = createBody.partial().refine((v) => Object.keys(v).length > 0, {
  message: "Provide at least one field to update",
});

/** Aggregated view: category, sensitivity, holding systems, volumes, transit. */
phiInventoryRouter.get("/", async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const items = await phiInventory(ctx);
    if (req.query.format === "csv") {
      await recordAudit(ctx, { action: "DATA_EXPORTED", entityType: "PHIType", metadata: { count: items.length }, req });
      maybeSendCsv(req, res, "phi-inventory.csv", items, [
        { header: "Category", value: (c) => c.name },
        { header: "Sensitivity", value: (c) => c.sensitivity },
        { header: "Records Held", value: (c) => c.recordsHeld },
        { header: "Systems", value: (c) => c.systems.map((s) => s.assetName).join("; ") },
        { header: "Flow Count", value: (c) => c.flowCount },
        { header: "Records/Day In Transit", value: (c) => c.recordsPerDayInTransit },
        { header: "Unencrypted Flows", value: (c) => c.unencryptedFlows },
      ]);
      return;
    }
    ok(res, items);
  } catch (err) {
    next(err);
  }
});

phiTypesRouter.get("/", async (req, res, next) => {
  try {
    ok(res, await listPhiTypes(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

phiTypesRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getPhiTypeById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});

phiTypesRouter.post("/", requirePermission("phitype:create"), validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const input = createBody.parse(req.body);
    const type = await createPhiType(ctx, input);
    await recordAudit(ctx, { action: "PHI_TYPE_CREATED", entityType: "PHIType", entityId: type.id, metadata: input, req });
    created(res, type);
  } catch (err) {
    next(err);
  }
});

phiTypesRouter.patch(
  "/:id", requirePermission("phitype:update"), validate({ params: idParam, body: patchBody }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      const before = await getPhiTypeById(ctx, id);
      const input = patchBody.parse(req.body);
      const after = await updatePhiType(ctx, id, input);
      await recordAudit(ctx, {
        action: "PHI_TYPE_UPDATED", entityType: "PHIType", entityId: id,
        metadata: { changes: diffFields(before, input) }, req,
      });
      ok(res, after);
    } catch (err) {
      next(err);
    }
  },
);
