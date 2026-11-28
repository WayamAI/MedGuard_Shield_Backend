/**
 * One-command local setup, no Docker required: `npm run setup`.
 * Creates medguard_dev if it doesn't exist, migrates it, and seeds the
 * Meridian demo data. After this, `npm run dev` is enough to start working.
 *
 * Requires a running local Postgres (`brew services start postgresql@16` or
 * similar) and reads DATABASE_URL from .env (copy .env.example first if you
 * haven't). See README.md's "Local setup (no Docker)" section.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { Client } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in first.");
  }

  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  console.log(`[setup] target database: "${dbName}"`);

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });

  try {
    await admin.connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach Postgres at ${adminUrl.host}. Start it first ` +
        `(e.g. \`brew services start postgresql@16\`). Underlying error: ${reason}`,
      { cause: err },
    );
  }

  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) {
      console.log(`[setup] creating database "${dbName}"...`);
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    } else {
      console.log(`[setup] database "${dbName}" already exists`);
    }
  } finally {
    await admin.end();
  }

  console.log("[setup] running migrations...");
  execSync("npx prisma migrate deploy", { stdio: "inherit" });

  console.log("[setup] seeding the Meridian demo data...");
  execSync("npm run db:seed", { stdio: "inherit" });

  console.log("[setup] done — run `npm run dev` to start the API.");
}

main().catch((err) => {
  console.error("[setup] failed:", err);
  process.exit(1);
});
