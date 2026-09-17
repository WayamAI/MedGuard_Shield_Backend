import cors from "cors";
import express from "express";
import helmet from "helmet";
import { assetsRouter } from "./routes/assets.js";
import { authRouter } from "./routes/auth.js";
import { dataFlowsRouter } from "./routes/dataflows.js";
import { risksRouter } from "./routes/risks.js";
import { vendorsRouter } from "./routes/vendors.js";
import { accessRouter } from "./routes/access.js";
import { threatsRouter } from "./routes/threats.js";
import { importRouter } from "./routes/import.js";
import { requireAuth } from "./middleware/auth.js";
import { createGlobalLimiter, createLoginLimiter } from "./middleware/security.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  // Security headers first, so they are present on every response including
  // errors and rate-limit rejections. contentSecurityPolicy is off because
  // this process serves JSON only -- a CSP here would protect nothing while
  // risking confusion with the frontend's own policy.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Trust the first proxy hop so rate limiting keys on the real client IP
  // rather than a load balancer's, once this sits behind one.
  app.set("trust proxy", 1);

  app.use(createGlobalLimiter());

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

  // Public: you cannot present a token before you have one. The login route
  // carries its own much tighter limit on top of the global one.
  app.use("/api/auth/login", createLoginLimiter());
  app.use("/api/auth", authRouter);

  // Everything past this line requires a valid session.
  app.use("/api", requireAuth);

  app.use("/api/assets", assetsRouter);
  app.use("/api/dataflows", dataFlowsRouter);
  app.use("/api/risks", risksRouter);
  app.use("/api/vendors", vendorsRouter);
  app.use("/api/access", accessRouter);
  app.use("/api/threats", threatsRouter);
  app.use("/api/import", importRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
