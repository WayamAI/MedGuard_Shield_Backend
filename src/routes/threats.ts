import { Router } from "express";
import { listThreats } from "../services/threatService.js";

export const threatsRouter = Router();

threatsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listThreats() });
  } catch (err) {
    next(err);
  }
});
