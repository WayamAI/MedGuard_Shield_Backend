import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * `src/config.ts` validates at import time (a top-level `loadEnv()` call),
 * so the only way to exercise "does it throw" for different env
 * combinations without one test's env leaking into the next is a fresh
 * process per case.
 */
function runConfig(env: Record<string, string>): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", "await import('./src/config.ts')"],
      { env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe" },
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number; stderr: string };
    return { status: e.status, output: e.stderr };
  }
}

describe("production boot guard", () => {
  it("refuses to start in production against a database whose name contains 'demo'", () => {
    const { status, output } = runConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pw@host:5432/medguard_demo?schema=public",
      JWT_SECRET: "a-sufficiently-long-test-secret-value",
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/Refusing to start in production.*"medguard_demo"/s);
  });

  it("boots fine in production against a normally-named database", () => {
    const { status } = runConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pw@host:5432/drishti_prod?schema=public",
      JWT_SECRET: "a-sufficiently-long-test-secret-value",
    });
    expect(status).toBe(0);
  });

  it("does not apply the guard outside production — dev/test against a 'demo'-named database is fine", () => {
    const { status } = runConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pw@host:5432/medguard_demo_test?schema=public",
      JWT_SECRET: "a-sufficiently-long-test-secret-value",
    });
    expect(status).toBe(0);
  });
});
