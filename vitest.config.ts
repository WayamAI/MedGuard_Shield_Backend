import { configDefaults, defineConfig } from "vitest/config";

/**
 * Integration tests hit real Express routes against a real Postgres, so they
 * need a database of their own. Pointing them at medguard_dev would wipe the
 * demo data every run, so DATABASE_URL is overridden here and
 * tests/setup/globalSetup.ts refuses to start if the target is not a test
 * database.
 *
 * These are assigned onto process.env rather than passed only through
 * test.env, because globalSetup runs in the Vitest host process, which
 * test.env does not reach.
 */
const TEST_ENV = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/medguard_test?schema=public`,
  JWT_SECRET: "test-only-signing-key-not-used-anywhere-real",
  DEMO_USER_PASSWORD: "test-password",
  FRONTEND_ORIGIN: "http://localhost:8080",
  NODE_ENV: "test",
};

Object.assign(process.env, TEST_ENV);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // demo-reset.test.ts needs a database whose name contains "demo" (it
    // exercises the audit trigger's DELETE exception and reset-demo.ts's own
    // "demo" guard) — see vitest.demo-reset.config.ts, run separately by
    // `npm test` so the two never share one DATABASE_URL.
    exclude: [
      ...configDefaults.exclude,
      "tests/integration/demo-reset.test.ts",
      "tests/integration/meridian-seed.test.ts",
    ],
    globalSetup: ["tests/setup/globalSetup.ts"],
    // Integration tests share one database; parallel files would race on the
    // same rows, so run them one file at a time.
    fileParallelism: false,
    // Fixture setup truncates every table and seeds rows. That is real work,
    // and on a loaded machine it occasionally breached the 10s default and
    // failed a hook that was merely slow, not broken.
    hookTimeout: 30_000,
    env: TEST_ENV,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/generated/**"],
      // The risk-scoring engine is the one place a silent regression changes
      // a customer-facing number; everything else is covered by the broader
      // route/service integration tests but not held to a numeric floor yet.
      thresholds: {
        "src/services/riskScoring.ts": { statements: 100, branches: 100 },
        "src/services/riskFactors.ts": { statements: 100, branches: 100 },
      },
    },
  },
});
