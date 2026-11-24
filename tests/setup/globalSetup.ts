import { execSync, spawn } from "node:child_process";
import { Client } from "pg";

const MAILPIT_HTTP = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";

/**
 * Brings the test database up to the current schema once per run — and, as
 * of this change, creates it first if it doesn't exist yet, so a fresh
 * clone needs only a running local Postgres plus `npm test`, not three
 * manually pre-created databases. See docs/engineering/VERIFICATION.md for
 * why this replaced the Testcontainers plan (no Docker on this machine).
 *
 * The "test" guard is the important part: these tests truncate every table,
 * so pointing them at a database whose name does not say "test" would
 * destroy real data. Refusing to run is the correct response, not a warning.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set for the test run");

  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}". ` +
        `The name must contain "test" — these tests truncate every table.`,
    );
  }

  await ensureDatabaseExists(url, dbName);

  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });

  await ensureMailpitRunning();
}

/**
 * The auth-email tests (invite, forgot-password) read what mailer.ts "sent"
 * back out of Mailpit's HTTP API (see tests/helpers.ts's clearMailpit/
 * latestMailTo). Previously a docker-compose service; now the native
 * binary (`brew install mailpit`), started here if it isn't already
 * running. Fails with a clear message if the binary isn't installed at
 * all, rather than letting every email test fail separately with a
 * confusing fetch error.
 */
async function ensureMailpitRunning(): Promise<void> {
  if (await mailpitReachable()) return;

  try {
    // detached + unref: outlives this process, the same way `mailpit &`
    // from a shell would, so it stays up across every vitest config this
    // globalSetup runs for instead of being killed when the first one exits.
    const child = spawn("mailpit", [], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    throw new Error(
      "Mailpit is not running and the `mailpit` binary was not found. " +
        "Install it with `brew install mailpit`, or start it yourself, then re-run the tests.",
    );
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    if (await mailpitReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Started \`mailpit\` but it never became reachable at ${MAILPIT_HTTP} within 5s. ` +
      "Check nothing else is bound to its ports (SMTP :1025, HTTP :8025).",
  );
}

async function mailpitReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_HTTP}/api/v1/messages`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Connects to Postgres's own always-present `postgres` database (not the
 * target test database, which may not exist yet) just to check for the
 * target and CREATE DATABASE it if missing. A missing database is normal on
 * a fresh clone; an unreachable Postgres is not, so that case gets its own,
 * clearer message rather than whatever raw connection-refused error pg
 * throws.
 */
async function ensureDatabaseExists(url: string, dbName: string): Promise<void> {
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });

  try {
    await admin.connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach Postgres at ${adminUrl.host} to prepare the test database "${dbName}". ` +
        `Start Postgres (e.g. \`brew services start postgresql\`) and try again. Underlying error: ${reason}`,
      { cause: err },
    );
  }

  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) {
      // Database names can't be parameterized the way query params can;
      // dbName is only ever one of this repo's own fixed test-database
      // names (it came from DATABASE_URL and already passed the "test"
      // guard above), never request or user input. Quoted and escaped
      // defensively anyway.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}
