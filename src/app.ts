import { createRequire } from "node:module";
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
import { ingestRouter } from "./routes/ingest.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { membersRouter } from "./routes/members.js";
import { notificationsRouter } from "./routes/notifications.js";
import { organizationRouter } from "./routes/organization.js";
import { phiInventoryRouter, phiTypesRouter } from "./routes/phiInventory.js";
import { policiesRouter } from "./routes/policies.js";
import { remediationsRouter } from "./routes/remediations.js";
import { reportsRouter } from "./routes/reports.js";
import { risksRouter } from "./routes/risks.js";
import { searchRouter } from "./routes/search.js";
import { threatsRouter } from "./routes/threats.js";
import { vendorsRouter } from "./routes/vendors.js";
import { prisma } from "./lib/prisma.js";
import { env, isProduction } from "./config.js";

/**
 * The version /health reports.
 *
 * Read from package.json rather than process.env.npm_package_version, which
 * npm sets only for a process it spawned itself. The container runs
 * `node dist/server.js` directly, so under Docker -- which is to say in
 * production -- that variable is absent and the old fallback silently served a
 * stale hardcoded version. package.json ships in the runtime image beside
 * dist/, so this resolves in the container and from src/ under tsx alike.
 *
 * Defensive on purpose: a liveness probe that throws is worse than one that
 * cannot name its own version.
 */
const VERSION = ((): string => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
import { requireAuth } from "./middleware/auth.js";
import {
  createExportLimiter, createGlobalLimiter, createIngestLimiter, createLoginLimiter,
} from "./middleware/security.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { httpLogger } from "./middleware/logging.js";

export function createApp() {
  const app = express();

  // Security headers first, so they are present on every response including
  // errors and rate-limit rejections. contentSecurityPolicy is off because
  // this process serves JSON only -- a CSP here would protect nothing while
  // risking confusion with the frontend's own policy.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Request-ID + structured logging, before anything that might error, so
  // every response — including rate-limit rejections and auth failures —
  // gets logged and carries the same id as its error envelope.
  app.use(httpLogger);

  // Trust the first proxy hop so rate limiting keys on the real client IP
  // rather than a load balancer's, once this sits behind one.
  app.set("trust proxy", 1);

  app.use(createGlobalLimiter());
  // Self-skipping for every request that isn't a `?format=csv` export, so
  // this one mount covers every export endpoint without touching each
  // route file individually.
  app.use(createExportLimiter());

  /**
   * CORS. A comma-separated FRONTEND_ORIGIN allows more than one origin, which
   * a preview deployment needs; the list is still an allowlist, never a
   * wildcard, because credentials:true is what lets the browser send the
   * session cookie and `*` is invalid with credentials in any case.
   */
  const origins = env.FRONTEND_ORIGIN
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors({ origin: origins, credentials: true }));

  // Explicitly the body-parser default. JSON payloads here are small --
  // imports arrive as multipart and are bounded separately by multer -- so a
  // larger ceiling would widen the DoS surface for no functional gain.
  app.use(express.json({ limit: "100kb" }));

  /**
   * Public. Health stays outside /api precisely so the auth gate below never
   * applies to it — a probe that needs a token is not a liveness probe.
   */
  const liveness = (_req: express.Request, res: express.Response) => {
    res.json({
      status: "ok",
      service: "drishti-api",
      version: VERSION,
    });
  };
  app.get("/health", liveness);
  // Conventional alias for infra that expects /healthz specifically.
  app.get("/healthz", liveness);

  /**
   * Readiness, as distinct from liveness. `/health` above answers "is this
   * process up"; this answers "can it actually serve a request", which means
   * reaching Postgres. They are kept apart deliberately: a liveness probe that
   * fails when the database blips gets the container killed for someone else's
   * outage.
   *
   * This is also the URL the hosted demo's keepalive pings. That matters more
   * than it looks: the free Postgres tier suspends a project that sees no
   * database traffic, so a ping against the static /health would keep the API
   * warm while the database went to sleep underneath it. The round trip here
   * is what keeps both ends awake.
   */
  const readiness = async (_req: express.Request, res: express.Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready", service: "drishti-api" });
    } catch {
      // The reason is deliberately not echoed: this endpoint is public, and a
      // driver error carries the host and database name. It is logged for the
      // operator instead.
      console.error("[drishti] readiness probe failed: database unreachable");
      res.status(503).json({ status: "degraded", service: "drishti-api" });
    }
  };
  app.get("/health/ready", readiness);
  // Conventional alias for infra that expects /readyz specifically.
  app.get("/readyz", readiness);

  /**
   * The generated OpenAPI spec (npm run openapi:generate), served raw rather
   * than through a UI dependency — never in production, since it both
   * describes attack surface and is only useful to people building against
   * a non-production environment anyway.
   */
  if (!isProduction) {
    app.get("/api/docs", (_req, res) => {
      try {
        const require = createRequire(import.meta.url);
        const spec = require("../openapi.json");
        res.json(spec);
      } catch {
        res.status(404).json({
          error: { code: "SPEC_NOT_FOUND", message: "Run `npm run openapi:generate` first." },
        });
      }
    });
  }

  // Public: you cannot present a token before you have one. Login carries its
  // own much tighter limit on top of the global one.
  app.use("/api/auth/login", createLoginLimiter());
  app.use("/api/auth", authRouter);

  // Ingestion is authenticated by its own API key, not a session, so it is
  // mounted here too — before the session gate below would otherwise
  // reject it for having no cookie or bearer token.
  app.use("/api/ingest", createIngestLimiter(), ingestRouter);

  // Everything past this line requires a valid session. requireAuth is also
  // where req.ctx.organizationId originates — every scoped query downstream
  // filters on it, and nothing reads a tenant id from request input.
  app.use("/api", requireAuth);

  app.use("/api/organization", organizationRouter);
  app.use("/api/members", membersRouter);
  app.use("/api/notifications", notificationsRouter);
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
  app.use("/api/api-keys", apiKeysRouter);
  app.use("/api/phi-inventory", phiInventoryRouter);
  app.use("/api/phi-types", phiTypesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
