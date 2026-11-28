import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env, isProduction } from "../config.js";

/**
 * One PrismaClient for the whole process.
 *
 * `tsx watch` re-evaluates modules on every save, so without this global cache
 * each reload would open a fresh connection pool and Postgres would run out of
 * connections after a handful of edits.
 *
 * Prisma 7 requires an explicit driver adapter: the connection string comes
 * from DATABASE_URL here, and from prisma.config.ts for the CLI.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    log: isProduction ? ["error"] : ["warn", "error"],
  });

if (!isProduction) globalForPrisma.prisma = prisma;
