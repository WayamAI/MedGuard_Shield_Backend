import { Router } from "express";
import { listAccessGrants } from "../services/accessService.js";

export const accessRouter = Router();

accessRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listAccessGrants() });
  } catch (err) {
    next(err);
  }
});
