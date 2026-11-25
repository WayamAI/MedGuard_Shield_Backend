import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Same fresh-process pattern as src/config.test.ts: the guard runs at the top of main(), before any connection, so a bad DATABASE_URL never needs a real database. */
function run(databaseUrl: string): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", "await import('./scripts/e2e-reset.ts').then(m => m.main?.())"],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8", stdio: "pipe" },
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number; stderr: string };
    return { status: e.status, output: e.stderr };
  }
}

describe("db:e2e:reset guard", () => {
  it("refuses a database whose name doesn't contain \"test\"", () => {
    const { status, output } = run("postgresql://user:pw@localhost:5432/medguard_dev?schema=public");
    expect(status).not.toBe(0);
    expect(output).toMatch(/Refusing to run db:e2e:reset.*"medguard_dev"/s);
  });

  it("refuses when DATABASE_URL is not set", () => {
    const { status, output } = run("");
    expect(status).not.toBe(0);
    expect(output).toMatch(/DATABASE_URL is not set/);
  });
});
