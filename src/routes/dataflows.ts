import { Router } from "express";
import { listDataFlows } from "../services/dataFlowService.js";

export const dataFlowsRouter = Router();

dataFlowsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listDataFlows() });
  } catch (err) {
    next(err);
  }
});
