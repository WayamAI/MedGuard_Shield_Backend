import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * BCRYPT_COST is lowered under NODE_ENV=test (see authService.ts) to keep
 * the integration suite fast. This is the regression test for the only
 * direction that matters: production must still get the real cost. A
 * fresh process per case, same reason as config.test.ts — the cost is
 * baked in at module import time from env.NODE_ENV, not re-checked per
 * call, so there is no way to flip it mid-process.
 */
function hashInEnv(nodeEnv: string): { status: number; hash?: string; stderr: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import", "tsx",
        "-e",
        "const { hashPassword } = await import('./src/services/authService.ts'); process.stdout.write(await hashPassword('correct-horse-battery-staple'));",
      ],
      {
        env: { ...process.env, NODE_ENV: nodeEnv, JWT_SECRET: "a-sufficiently-long-test-secret-value" },
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    return { status: 0, hash: output, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stderr: string };
    return { status: e.status, stderr: e.stderr };
  }
}

describe("BCRYPT_COST", () => {
  it("is 12 in production — a bcrypt hash encodes its own cost factor in the string", () => {
    const { status, hash } = hashInEnv("production");
    expect(status).toBe(0);
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
  });

  it("is lowered to 4 under test, so the hash string reflects that instead", () => {
    const { status, hash } = hashInEnv("test");
    expect(status).toBe(0);
    expect(hash).toMatch(/^\$2[aby]\$04\$/);
  });

  it("is 12 in plain development too — only NODE_ENV=test gets the fast path", () => {
    const { status, hash } = hashInEnv("development");
    expect(status).toBe(0);
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
  });
});
