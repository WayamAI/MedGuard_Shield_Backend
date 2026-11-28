import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf, requirePermission } from "../middleware/auth.js";
import { created, ok } from "../lib/http.js";
import { recordAudit } from "../services/auditService.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apiKeyService.js";

export const apiKeysRouter = Router();

apiKeysRouter.get("/", requirePermission("apikey:read"), async (req, res, next) => {
  try {
    ok(res, await listApiKeys(ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

const createBody = z.object({ name: z.string().trim().min(1).max(120) });

/** The secret is returned exactly once, in this response, and is unrecoverable afterward. */
apiKeysRouter.post("/", requirePermission("apikey:create"), validate({ body: createBody }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const { name } = createBody.parse(req.body);
    const key = await createApiKey(ctx, name);
    await recordAudit(ctx, { action: "API_KEY_CREATED", entityType: "ApiKey", entityId: key.id, metadata: { name }, req });
    created(res, key);
  } catch (err) {
    next(err);
  }
});

export const idParam = z.object({ id: z.coerce.number().int().positive() });

apiKeysRouter.post(
  "/:id/revoke", requirePermission("apikey:revoke"), validate({ params: idParam }),
  async (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const { id } = idParam.parse(req.params);
      await revokeApiKey(ctx, id);
      await recordAudit(ctx, { action: "API_KEY_REVOKED", entityType: "ApiKey", entityId: id, req });
      ok(res, { ok: true });
    } catch (err) {
      next(err);
    }
  },
);
