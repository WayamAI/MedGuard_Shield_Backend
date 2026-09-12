import { execSync } from "node:child_process";

/**
 * Brings the test database up to the current schema once per run.
 *
 * The guard is the important part: these tests truncate every table, so
 * pointing them at a database whose name does not say "test" would destroy
 * real data. Refusing to run is the correct response, not a warning.
 */
export default function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set for the test run");

  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}". ` +
        `The name must contain "test" — these tests truncate every table.`,
    );
  }

  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });
}
