import cors from "cors";
import express from "express";
import helmet from "helmet";
import { accessRouter } from "./routes/access.js";
import { assetsRouter } from "./routes/assets.js";
import { auditRouter } from "./routes/audit.js";
import { authRouter } from "./routes/auth.js";
import { controlsRouter } from "./routes/controls.js";
import { dataFlowsRouter } from "./routes/dataflows.js";
import { identitiesRouter } from "./routes/identities.js";
import { importRouter } from "./routes/import.js";
import { organizationRouter } from "./routes/organization.js";
import { policiesRouter } from "./routes/policies.js";
import { remediationsRouter } from "./routes/remediations.js";
import { reportsRouter } from "./routes/reports.js";
import { risksRouter } from "./routes/risks.js";
import { searchRouter } from "./routes/search.js";
import { threatsRouter } from "./routes/threats.js";
import { vendorsRouter } from "./routes/vendors.js";
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

  /**
   * CORS. A comma-separated FRONTEND_ORIGIN allows more than one origin, which
   * a preview deployment needs; the list is still an allowlist, never a
   * wildcard, because credentials:true is what lets the browser send the
   * session cookie and `*` is invalid with credentials in any case.
   */
  const origins = (process.env.FRONTEND_ORIGIN ?? "http://localhost:8080")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors({ origin: origins, credentials: true }));

  app.use(express.json({ limit: "1mb" }));

  /**
   * Public. Health stays outside /api precisely so the auth gate below never
   * applies to it — a probe that needs a token is not a liveness probe.
   */
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "drishti-api",
      version: process.env.npm_package_version ?? "0.2.0",
    });
  });

  // Public: you cannot present a token before you have one. Login carries its
  // own much tighter limit on top of the global one.
  app.use("/api/auth/login", createLoginLimiter());
  app.use("/api/auth", authRouter);

  // Everything past this line requires a valid session. requireAuth is also
  // where req.ctx.organizationId originates — every scoped query downstream
  // filters on it, and nothing reads a tenant id from request input.
  app.use("/api", requireAuth);

  app.use("/api/organization", organizationRouter);
  app.use("/api/assets", assetsRouter);
  app.use("/api/dataflows", dataFlowsRouter);
  app.use("/api/risks", risksRouter);
  app.use("/api/vendors", vendorsRouter);
  app.use("/api/identities", identitiesRouter);
  app.use("/api/access", accessRouter);
  app.use("/api/threats", threatsRouter);
  app.use("/api/controls", controlsRouter);
  app.use("/api/policies", policiesRouter);
  app.use("/api/remediations", remediationsRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/import", importRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
