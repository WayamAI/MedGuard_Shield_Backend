import { z } from "zod";

/**
 * Validates the process environment once, at import time, so a
 * misconfigured deploy fails on boot with one clear message instead of on
 * the first request that happens to touch the missing variable (the
 * previous failure mode for JWT_SECRET, which was only checked inside
 * `authService.signingSecret()` on first login).
 *
 * Import this before anything else in `server.ts` so validation runs before
 * the app starts listening.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is not set — copy .env.example to .env and fill it in."),
  JWT_SECRET: z.string().min(16, "JWT_SECRET is missing or too short (need 16+ chars) — see .env.example"),
  FRONTEND_ORIGIN: z.string().min(1).default("http://localhost:8080"),
  DEMO_USER_PASSWORD: z.string().optional(),
});

/** The database name out of a postgres:// URL, same extraction reset-demo.ts and globalSetup.ts use. */
function databaseNameFrom(databaseUrl: string): string {
  return databaseUrl.split("/").pop()?.split("?")[0] ?? "";
}

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  // The audit trigger's one DELETE exception is keyed on the database name
  // containing "demo" (see the audit_delete_by_database_name migration) --
  // a database that looks like a demo/test one but is actually serving
  // production traffic would silently lose audit immutability. Refusing to
  // boot is the correct response, not a warning.
  if (parsed.data.NODE_ENV === "production") {
    const dbName = databaseNameFrom(parsed.data.DATABASE_URL);
    if (dbName.toLowerCase().includes("demo")) {
      throw new Error(
        `Refusing to start in production against database "${dbName}": its name contains "demo", ` +
          `which disables audit-trail immutability for it. Point production at a differently-named database.`,
      );
    }
  }

  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
