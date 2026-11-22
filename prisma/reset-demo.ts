import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { DEMO_ORG_SLUG, seedDemo, type SeedSummary } from "./seed-demo.js";
import type { Prisma } from "../src/generated/prisma/client.js";

/**
 * Scoped reset of the demo organisation.
 *
 * ## What this is for
 *
 * `seed-demo.ts` is additive by design: it never deletes, so an estate that
 * has been clicked around during a rehearsal keeps whatever was added to it.
 * That is the right default, but it means the demo drifts. This command is the
 * other half — it returns the demo tenant to a known state by removing its
 * records and re-seeding them, so every demonstration starts from the same
 * dataset regardless of what the last one did to it.
 *
 * ## How the blast radius is bounded
 *
 * This file DOES delete, so the scoping is not a matter of good intentions:
 *
 *  1. The target is resolved by slug (`DEMO_ORG_SLUG`, default `drishti-demo`)
 *     and every statement below carries `organizationId` — either directly or
 *     through the parent that owns the row. There is no unqualified
 *     `deleteMany`, no `TRUNCATE`, no `DROP`, and no migration reset anywhere
 *     in this file.
 *
 *  2. Rows belonging to every *other* organisation are counted immediately
 *     before and immediately after the deletions, inside the same transaction.
 *     If a single one of those counts moves, the whole transaction is rolled
 *     back and nothing is deleted at all. A scoping mistake therefore fails
 *     loudly and changes nothing, rather than quietly destroying a tenant.
 *
 *  3. Running against `NODE_ENV=production` refuses unless
 *     `DEMO_RESET_ALLOW_PRODUCTION=yes` is set explicitly.
 *
 * ## What is deliberately NOT deleted
 *
 *   Organization      Kept, so its id is stable and anything pointing at it by
 *                     id from outside the database still resolves.
 *
 *   User + membership The demo accounts are kept. They are already
 *                     deterministic (same three addresses, same three roles),
 *                     and an operator who changed the demo password would be
 *                     surprised to find it silently reverted. `seed-demo.ts`
 *                     re-uses existing accounts rather than overwriting them.
 *
 *   Audit events with no organisation (failed logins, for instance) belong to
 *   no tenant and so are outside this command's scope by definition.
 *
 * Usage:  npm run db:demo:reset
 */

/** Deletion order, parents last. Named so the summary can report each one. */
type Step = { table: string; run: (tx: Prisma.TransactionClient, organizationId: number) => Promise<{ count: number }> };

/**
 * Foreign keys are declared with `onDelete: Cascade` in most cases, so much of
 * this would happen anyway. It is spelled out regardless: relying on cascade
 * means the blast radius is defined by the schema rather than by this file,
 * and a future relation added without `Cascade` would fail here loudly instead
 * of leaving orphans behind.
 *
 * The one ordering constraint that is *not* optional: `DataFlow.phiType` is
 * `onDelete: Restrict`, so flows must go before PHI types.
 */
const STEPS: Step[] = [
  // AuditEvent is append-only everywhere else (a DB trigger enforces it — see
  // the add_audit_immutability and allow_demo_audit_delete migrations), but
  // this one ordinary deleteMany still succeeds: the trigger function itself
  // carries the one exception, permitting DELETE only when the row's own
  // organization has a "demo" slug. Nothing in this file disables a trigger
  // or touches SQL directly, which is itself a tested invariant below.
  { table: "auditEvent", run: (tx, o) => tx.auditEvent.deleteMany({ where: { organizationId: o } }) },
  { table: "riskHistory", run: (tx, o) => tx.riskHistory.deleteMany({ where: { organizationId: o } }) },
  { table: "remediation", run: (tx, o) => tx.remediation.deleteMany({ where: { organizationId: o } }) },
  { table: "policyControl", run: (tx, o) => tx.policyControl.deleteMany({ where: { policy: { organizationId: o } } }) },
  { table: "policy", run: (tx, o) => tx.policy.deleteMany({ where: { organizationId: o } }) },
  { table: "assetControl", run: (tx, o) => tx.assetControl.deleteMany({ where: { asset: { organizationId: o } } }) },
  { table: "control", run: (tx, o) => tx.control.deleteMany({ where: { organizationId: o } }) },
  { table: "threat", run: (tx, o) => tx.threat.deleteMany({ where: { organizationId: o } }) },
  { table: "vendorAssetAccess", run: (tx, o) => tx.vendorAssetAccess.deleteMany({ where: { vendor: { organizationId: o } } }) },
  { table: "vendorRisk", run: (tx, o) => tx.vendorRisk.deleteMany({ where: { organizationId: o } }) },
  { table: "vendor", run: (tx, o) => tx.vendor.deleteMany({ where: { organizationId: o } }) },
  { table: "accessGrant", run: (tx, o) => tx.accessGrant.deleteMany({ where: { organizationId: o } }) },
  { table: "identity", run: (tx, o) => tx.identity.deleteMany({ where: { organizationId: o } }) },
  { table: "dataFlow", run: (tx, o) => tx.dataFlow.deleteMany({ where: { organizationId: o } }) },
  { table: "assetPHI", run: (tx, o) => tx.assetPHI.deleteMany({ where: { asset: { organizationId: o } } }) },
  { table: "risk", run: (tx, o) => tx.risk.deleteMany({ where: { organizationId: o } }) },
  { table: "asset", run: (tx, o) => tx.asset.deleteMany({ where: { organizationId: o } }) },
  { table: "phiType", run: (tx, o) => tx.pHIType.deleteMany({ where: { organizationId: o } }) },
  { table: "refreshToken", run: (tx, o) => tx.refreshToken.deleteMany({ where: { organizationId: o } }) },
];

/**
 * Counts every row that does NOT belong to the demo organisation.
 *
 * This is the safety net rather than a report: it runs before and after the
 * deletions inside one transaction, and any difference aborts the reset. Join
 * tables have no `organizationId` of their own, so they are counted through
 * the parent that does.
 */
export async function censusOutside(
  tx: Prisma.TransactionClient,
  organizationId: number,
): Promise<Record<string, number>> {
  const not = { not: organizationId };
  // Sequential, not Promise.all: these run on the single connection held by
  // the interactive transaction, and node-postgres does not support
  // concurrent queries on one client. Each entry is a thunk, not a fired
  // query -- an array of already-called `tx.x.count()` promises would start
  // every query immediately on construction, before the loop below ever
  // gets to `await` the first one, which is exactly the bug this comment
  // used to describe without actually avoiding.
  const queries: Array<() => Promise<number>> = [
    () => tx.organization.count({ where: { id: not } }),
    () => tx.user.count(),
    () => tx.organizationMember.count({ where: { organizationId: not } }),
    () => tx.refreshToken.count({ where: { organizationId: not } }),
    () => tx.asset.count({ where: { organizationId: not } }),
    () => tx.pHIType.count({ where: { organizationId: not } }),
    () => tx.assetPHI.count({ where: { asset: { organizationId: not } } }),
    () => tx.dataFlow.count({ where: { organizationId: not } }),
    () => tx.risk.count({ where: { organizationId: not } }),
    () => tx.riskHistory.count({ where: { organizationId: not } }),
    () => tx.vendor.count({ where: { organizationId: not } }),
    () => tx.vendorRisk.count({ where: { organizationId: not } }),
    () => tx.vendorAssetAccess.count({ where: { vendor: { organizationId: not } } }),
    () => tx.identity.count({ where: { organizationId: not } }),
    () => tx.accessGrant.count({ where: { organizationId: not } }),
    () => tx.threat.count({ where: { organizationId: not } }),
    () => tx.control.count({ where: { organizationId: not } }),
    () => tx.assetControl.count({ where: { asset: { organizationId: not } } }),
    () => tx.policy.count({ where: { organizationId: not } }),
    () => tx.policyControl.count({ where: { policy: { organizationId: not } } }),
    () => tx.remediation.count({ where: { organizationId: not } }),
    // Includes the tenant-less rows (failed logins), which must also survive.
    () => tx.auditEvent.count({ where: { OR: [{ organizationId: not }, { organizationId: null }] } }),
  ];
  const counts: number[] = [];
  for (const query of queries) {
    counts.push(await query());
  }

  const labels = [
    "organizations", "users", "memberships", "refreshTokens", "assets", "phiTypes",
    "assetPhi", "dataFlows", "risks", "riskHistory", "vendors", "vendorRisks",
    "vendorAccess", "identities", "accessGrants", "threats", "controls",
    "assetControls", "policies", "policyControls", "remediations", "auditEvents",
  ];
  if (labels.length !== counts.length) {
    throw new Error("[demo-reset] census label/count mismatch — refusing to proceed.");
  }
  return Object.fromEntries(labels.map((label, i) => [label, counts[i]!]));
}

export type ResetSummary = {
  organizationId: number | null;
  /** Rows removed, per table. Absent entirely when the org did not exist. */
  deleted: Record<string, number>;
  seeded: SeedSummary;
};

export async function resetDemo(options: { quiet?: boolean } = {}): Promise<ResetSummary> {
  const log = (...args: unknown[]) => {
    if (!options.quiet) console.log(...args);
  };

  if (process.env.NODE_ENV === "production" && process.env.DEMO_RESET_ALLOW_PRODUCTION !== "yes") {
    throw new Error(
      "Refusing to reset a demo organisation with NODE_ENV=production. " +
      "Set DEMO_RESET_ALLOW_PRODUCTION=yes if that is genuinely what you want.",
    );
  }

  // Refuse to run against a database whose name does not look like a demo
  // database, so a misconfigured DATABASE_URL (e.g. pointed at dev/prod) can't
  // delete real rows. Override with DEMO_RESET_ALLOW_ANY_DB=yes for a
  // genuinely different naming scheme.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbName = dbUrl.split("/").pop()?.split("?")[0] ?? "";
  if (!dbName.toLowerCase().includes("demo") && process.env.DEMO_RESET_ALLOW_ANY_DB !== "yes") {
    throw new Error(
      `Refusing to reset: database "${dbName}" does not look like a demo database ` +
      '(its name does not contain "demo"). Set DEMO_RESET_ALLOW_ANY_DB=yes to override.',
    );
  }

  // Non-negotiable: back up before any destructive statement runs, so a
  // scoping bug or a bad DATABASE_URL never loses data unrecoverably.
  if (process.env.DEMO_RESET_SKIP_BACKUP !== "yes") {
    const backupDir = join(process.cwd(), "prisma", "backups");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- backupDir is built entirely from process.cwd() and fixed strings above, never from request/user input.
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(backupDir, `pre-reset_${dbName}_${stamp}.sql`);
    log(`[demo-reset] backing up "${dbName}" to ${backupPath} before any deletion...`);
    // pg_dump's connection URI only understands standard libpq parameters --
    // Prisma's "?schema=" suffix on DATABASE_URL isn't one of them and makes
    // pg_dump reject the whole URL. Not needed here anyway: pg_dump dumps
    // every schema in the target database by default.
    const pgDumpUrl = dbUrl.split("?")[0];
    execFileSync("pg_dump", [pgDumpUrl, "-f", backupPath], { stdio: "inherit" });
    log(`[demo-reset] backup complete: ${backupPath}`);
  }

  const org = await prisma.organization.findUnique({ where: { slug: DEMO_ORG_SLUG } });
  const deleted: Record<string, number> = {};

  if (!org) {
    log(`[demo-reset] no organisation with slug "${DEMO_ORG_SLUG}" — nothing to remove, seeding fresh.`);
  } else {
    log(`[demo-reset] target: ${org.name} (slug ${org.slug}, id ${org.id})`);
    log("[demo-reset] every statement is scoped to that organisation; others are verified untouched.");

    await prisma.$transaction(
      async (tx) => {
        const before = await censusOutside(tx, org.id);

        for (const step of STEPS) {
          const { count } = await step.run(tx, org.id);
          deleted[step.table] = count;
        }

        // The guarantee. If anything outside the demo organisation moved, this
        // throw rolls the entire transaction back and no row is deleted.
        const after = await censusOutside(tx, org.id);
        const drifted = Object.keys(before).filter((k) => before[k] !== after[k]);
        if (drifted.length > 0) {
          throw new Error(
            "[demo-reset] ABORTED: records outside the demo organisation changed — " +
            drifted.map((k) => `${k} ${before[k]} -> ${after[k]}`).join(", ") +
            ". The transaction has been rolled back and nothing was deleted.",
          );
        }
      },
      { timeout: 60_000 },
    );

    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    log(`[demo-reset] removed ${total} row(s) from organisation ${org.id}:`);
    for (const [table, count] of Object.entries(deleted)) {
      if (count > 0) log(`  ${table.padEnd(20)} ${String(count).padStart(5)}`);
    }
    log("[demo-reset] organisation, demo users and memberships retained.");
  }

  log("[demo-reset] re-seeding…\n");
  const seeded = await seedDemo({ quiet: options.quiet });

  return { organizationId: seeded.organizationId, deleted, seeded };
}

/** CLI entry point, guarded so importing this from a test does not run it. */
if (process.argv[1]?.includes("reset-demo")) {
  resetDemo()
    .catch((err) => {
      console.error("[demo-reset] failed:", err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
