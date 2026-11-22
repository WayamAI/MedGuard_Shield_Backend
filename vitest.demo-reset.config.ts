import { defineConfig } from "vitest/config";

/**
 * A separate config for `tests/integration/demo-reset.test.ts` only.
 *
 * That file exercises two things nothing else in the suite does: the audit
 * trigger's one DELETE exception (gated on the *database name* containing
 * "demo" — see prisma/migrations/.../audit_delete_by_database_name) and
 * reset-demo.ts's own guard, which refuses to run against a database whose
 * name doesn't say "demo". Running it against `medguard_test` would always
 * hit that guard and never actually exercise the reset path, which is
 * exactly what happened before this config existed. `DEMO_TEST_DATABASE_URL`
 * must point at a database whose name contains both "test" (so
 * globalSetup.ts's truncate guard is satisfied) and "demo" (so this guard and
 * the trigger exception are). Defaults to a local `medguard_demo_test`.
 */
const TEST_ENV = {
  DATABASE_URL:
    process.env.DEMO_TEST_DATABASE_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/medguard_demo_test?schema=public`,
  JWT_SECRET: "test-only-signing-key-not-used-anywhere-real",
  DEMO_USER_PASSWORD: "test-password",
  FRONTEND_ORIGIN: "http://localhost:8080",
  NODE_ENV: "test",
};

Object.assign(process.env, TEST_ENV);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/demo-reset.test.ts"],
    globalSetup: ["tests/setup/globalSetup.ts"],
    fileParallelism: false,
    hookTimeout: 30_000,
    env: TEST_ENV,
  },
});
