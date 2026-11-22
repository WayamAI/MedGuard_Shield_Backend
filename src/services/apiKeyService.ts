import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { UnauthorizedError } from "../services/authService.js";
import type { TenantContext } from "../lib/tenant.js";

function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Returns the plaintext secret once — the caller must show it to the admin now; it is never retrievable again. */
export async function createApiKey(ctx: TenantContext, name: string) {
  const secret = `drishti_${randomBytes(24).toString("base64url")}`;
  const key = await prisma.apiKey.create({
    data: { organizationId: ctx.organizationId, name, scope: "import", keyHash: hashKey(secret), createdById: ctx.userId },
  });
  return { id: key.id, name: key.name, secret, createdAt: key.createdAt };
}

export async function listApiKeys(ctx: TenantContext) {
  return prisma.apiKey.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, name: true, scope: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeApiKey(ctx: TenantContext, id: number) {
  const key = await prisma.apiKey.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!key) throw new UnauthorizedError("API key not found");
  return prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}

/** Verifies the presented secret and returns a TenantContext acting as that key, or throws. */
export async function authenticateApiKey(secret: string): Promise<TenantContext & { connectorId: number; connectorLabel: string }> {
  const key = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(secret) } });
  if (!key || key.revokedAt) throw new UnauthorizedError("Invalid or revoked API key");

  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });

  return {
    userId: key.createdById,
    email: `api-key:${key.name}`,
    role: "ADMIN",
    organizationId: key.organizationId,
    connectorId: key.id,
    connectorLabel: key.name,
  };
}
