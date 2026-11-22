import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { main as seedBootstrap } from "../../prisma/seed-bootstrap.js";

const ENV_KEYS = ["BOOTSTRAP_ORG_NAME", "BOOTSTRAP_ORG_SLUG", "BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_PASSWORD"] as const;

function clearBootstrapEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(async () => {
  clearBootstrapEnv();
  await prisma.organization.deleteMany({ where: { slug: "bootstrap-test-org" } });
  await prisma.user.deleteMany({ where: { email: "admin@bootstrap-test.example" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("bootstrap seed requires explicit credentials", () => {
  it("refuses to run with none of the required env vars set", async () => {
    clearBootstrapEnv();
    await expect(seedBootstrap()).rejects.toThrow(/BOOTSTRAP_ORG_NAME/);
  });

  it("refuses to run with only some of the required env vars set", async () => {
    clearBootstrapEnv();
    process.env.BOOTSTRAP_ORG_NAME = "Test Org";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@bootstrap-test.example";
    // BOOTSTRAP_ORG_SLUG and BOOTSTRAP_ADMIN_PASSWORD deliberately left unset.
    await expect(seedBootstrap()).rejects.toThrow(/BOOTSTRAP_ORG_NAME/);
  });

  it("creates exactly one org and one ADMIN user when all four are provided", async () => {
    process.env.BOOTSTRAP_ORG_NAME = "Bootstrap Test Org";
    process.env.BOOTSTRAP_ORG_SLUG = "bootstrap-test-org";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@bootstrap-test.example";
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "a-strong-bootstrap-password-1";

    await seedBootstrap();

    const org = await prisma.organization.findUnique({ where: { slug: "bootstrap-test-org" } });
    const user = await prisma.user.findUnique({ where: { email: "admin@bootstrap-test.example" } });
    expect(org?.name).toBe("Bootstrap Test Org");
    expect(user?.role).toBe("ADMIN");
  });
});
