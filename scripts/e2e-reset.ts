/**
 * Fast, deterministic reset of the Meridian demo data for frontend E2E
 * tests: `npm run db:e2e:reset`. Truncates and reseeds in seconds (it's the
 * same fixed, small dataset prisma/seed.ts always creates — RESTART IDENTITY
 * keeps ids stable across runs, so a frontend test suite can hardcode them).
 *
 * Deliberately stricter than `npm run db:seed` itself: that command is also
 * how the CEO-demo database gets (re)seeded, so it only refuses production.
 * This one additionally refuses any database whose name doesn't contain
 * "test" — an E2E suite runs this between tests or test files, and the one
 * way that goes wrong quietly is someone's E2E config accidentally pointing
 * at a real database.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run db:e2e:reset against database "${dbName}". ` +
        `The name must contain "test" — point DATABASE_URL at a dedicated E2E database.`,
    );
  }
}

export async function main(): Promise<void> {
  assertTestDatabase();
  const { main: seedMeridian } = await import("../prisma/seed.js");
  await seedMeridian();
  // seed.ts's own main() doesn't disconnect — it's also imported directly by
  // meridian-seed.test.ts, which keeps the connection alive across many
  // calls in one test run. This entrypoint is a one-shot CLI invocation, so
  // it owns closing the connection itself.
  const { prisma } = await import("../src/lib/prisma.js");
  await prisma.$disconnect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => console.log("[e2e-reset] done"))
    .catch((err) => {
      console.error("[e2e-reset] failed:", err);
      process.exitCode = 1;
    });
}
