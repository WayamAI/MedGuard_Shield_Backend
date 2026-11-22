/**
 * Bootstrap seed for a real install — not a demo.
 *
 * Creates exactly one organisation and one ADMIN user, both from env vars,
 * so a fresh production deploy has someone who can sign in and invite
 * everyone else through the (future) member-invite flow. Idempotent:
 * re-running with the same BOOTSTRAP_ORG_SLUG/BOOTSTRAP_ADMIN_EMAIL upserts
 * rather than duplicating.
 *
 * Deliberately has none of prisma/seed.ts's demo fixtures (assets, vendors,
 * threats, etc.) — those exist to make a demo look lived-in, which a real
 * tenant's first boot should never fake.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/services/authService.js";

export async function main() {
  const orgName = process.env.BOOTSTRAP_ORG_NAME;
  const orgSlug = process.env.BOOTSTRAP_ORG_SLUG;
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!orgName || !orgSlug || !adminEmail || !adminPassword) {
    throw new Error(
      "Set BOOTSTRAP_ORG_NAME, BOOTSTRAP_ORG_SLUG, BOOTSTRAP_ADMIN_EMAIL and " +
        "BOOTSTRAP_ADMIN_PASSWORD before running db:seed:bootstrap.",
    );
  }

  const org = await prisma.organization.upsert({
    where: { slug: orgSlug },
    update: { name: orgName },
    create: { name: orgName, slug: orgSlug },
  });

  const passwordHash = await hashPassword(adminPassword);
  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: { email: adminEmail, role: "ADMIN", passwordHash },
  });

  await prisma.organizationMember.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
    update: { role: "ADMIN" },
    create: { userId: user.id, organizationId: org.id, role: "ADMIN" },
  });

  console.log(`[seed:bootstrap] org "${org.name}" (${org.slug}), admin ${adminEmail}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
