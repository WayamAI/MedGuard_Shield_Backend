import cors from "cors";
import express from "express";
import { assetsRouter } from "./routes/assets.js";
import { authRouter } from "./routes/auth.js";
import { dataFlowsRouter } from "./routes/dataflows.js";
import { risksRouter } from "./routes/risks.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  // The frontend dev server's origin, from env so nothing is hardcoded.
  // credentials:true is what lets the browser send the session cookie.
  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:8080";
  app.use(cors({ origin: frontendOrigin, credentials: true }));

  app.use(express.json());

  // Public. Health stays outside /api precisely so the auth gate below
  // never applies to it.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Public: you cannot present a token before you have one.
  app.use("/api/auth", authRouter);

  // Everything past this line requires a valid session.
  app.use("/api", requireAuth);

  app.use("/api/assets", assetsRouter);
  app.use("/api/dataflows", dataFlowsRouter);
  app.use("/api/risks", risksRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
