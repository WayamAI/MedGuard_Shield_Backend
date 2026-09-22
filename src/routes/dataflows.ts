import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf } from "../middleware/auth.js";
import { ok, paged } from "../lib/http.js";
import { pageMeta, pageParams, paginationQuery } from "../lib/pagination.js";
import { getDataFlowById, listDataFlows } from "../services/dataFlowService.js";

export const dataFlowsRouter = Router();

const listQuery = paginationQuery.extend({
  status: z.enum(["ok", "warn", "violation"]).optional(),
  assetId: z.coerce.number().int().positive().optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

dataFlowsRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const page = pageParams(q);
    const { items, total } = await listDataFlows(ctxOf(req), q, page);
    paged(res, items, pageMeta(page, total));
  } catch (err) {
    next(err);
  }
});

dataFlowsRouter.get("/:id", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    ok(res, await getDataFlowById(ctxOf(req), id));
  } catch (err) {
    next(err);
  }
});
