import { defineConfig } from "vitest/config";

/**
 * A separate config for `tests/integration/meridian-seed.test.ts` only.
 *
 * `prisma/seed.ts` TRUNCATEs every core table before reseeding -- fine for
 * its intended use (`npm run db:seed`), but incompatible with running
 * alongside the rest of the suite in the shared `medguard_test` database,
 * which other test files' fixtures depend on staying put between files.
 * `MERIDIAN_TEST_DATABASE_URL` must point at its own database, name
 * containing "test" so globalSetup.ts's truncate guard is satisfied.
 * Defaults to a local `medguard_meridian_test`.
 */
const TEST_ENV = {
  DATABASE_URL:
    process.env.MERIDIAN_TEST_DATABASE_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/medguard_meridian_test?schema=public`,
  JWT_SECRET: "test-only-signing-key-not-used-anywhere-real",
  DEMO_USER_PASSWORD: "test-password",
  FRONTEND_ORIGIN: "http://localhost:8080",
  NODE_ENV: "test",
};

Object.assign(process.env, TEST_ENV);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/meridian-seed.test.ts"],
    globalSetup: ["tests/setup/globalSetup.ts"],
    fileParallelism: false,
    hookTimeout: 30_000,
    env: TEST_ENV,
  },
});
