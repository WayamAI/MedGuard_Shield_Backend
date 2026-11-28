import { createServer, type Server } from "node:net";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression for the silent-port-collision bug (see server.ts's comment on
 * the `error` handler): occupy the real port first with a plain TCP
 * listener, then spawn the actual server entrypoint against it and confirm
 * it exits non-zero with a clear message, instead of looking alive in `ps`
 * while never actually binding.
 */

let occupied: Server | undefined;

afterEach(async () => {
  if (!occupied) return;
  await new Promise<void>((resolve) => occupied?.close(() => resolve()));
  occupied = undefined;
});

function occupyPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, () => {
      occupied = server;
      resolve();
    });
  });
}

describe("server start", () => {
  it("exits non-zero with a clear message when the port is already taken", async () => {
    const port = 41234;
    await occupyPort(port);

    let threw = false;
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/server.ts"],
        {
          env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: "test",
            JWT_SECRET: "a-sufficiently-long-test-secret-value",
            DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost:5432/medguard_test?schema=public",
          },
          encoding: "utf8",
          stdio: "pipe",
          timeout: 10_000,
        },
      );
    } catch (err) {
      threw = true;
      const e = err as { status: number; stderr: string };
      expect(e.status).not.toBe(0);
      expect(e.stderr).toMatch(new RegExp(`Port ${port} is already in use`));
      expect(e.stderr).toMatch(/lsof -i/);
    }
    expect(threw, "server.ts should have exited non-zero").toBe(true);
  });
});
