# Engineering Decisions

## OpenAPI: `z.toJSONSchema`, not `@asteasolutions/zod-to-openapi`

**Decision**: generate `openapi.json` with Zod 4's built-in `z.toJSONSchema()`, wrapped by hand into an OpenAPI 3.1 document (`scripts/generate-openapi.ts`), rather than adding `@asteasolutions/zod-to-openapi`.

**Why**: OpenAPI 3.1 adopted JSON Schema 2020-12 directly, so a JSON Schema produced by `z.toJSONSchema({ target: "draft-2020-12" })` is already a valid OpenAPI 3.1 schema object with no translation layer. Confirmed working against the installed `zod@4.6.2` (no peer-dependency risk from a third-party library's own Zod-4 support claim). Two adjustments were needed in practice: `unrepresentable: "any"` (several routes validate `z.coerce.date()` fields, which have no native JSON Schema representation) and stripping the `$schema` key before embedding each schema in `components`/inline.

**How it's wired**: every route file exports its `idParam`/`listQuery`/`createBody`/`patchBody`/etc. Zod schemas (previously module-private consts — made `export const` across all 16 route files, a one-line change per schema, no behavior change). `scripts/generate-openapi.ts` imports them and maps each to the path/method list transcribed from `docs/engineering/ROUTE_INVENTORY.md`. Run via `npm run openapi:generate`; served at `GET /api/docs` outside production.

**Follow-up for Phase 4**: a contract test should validate live responses against this file so the two can't silently drift.

## Seed split: `db:seed` vs `db:seed:bootstrap` vs `db:seed:demo`

Three independent seed scripts now exist, each for a different situation — none of them replaces another:

- `db:seed` (`prisma/seed.ts`): destructive, truncates and rebuilds the full "Meridian Health System" demo estate used in the CEO-walkthrough demo. Dev/demo only.
- `db:seed:demo` (`prisma/seed-demo.ts`): non-destructive upsert into a separate, unrelated "Drishti Demo Healthcare" org — pre-existing, left untouched.
- `db:seed:bootstrap` (`prisma/seed-bootstrap.ts`, new): the only one safe to run against a real production database. Creates exactly one org + one ADMIN user from `BOOTSTRAP_ORG_NAME`/`BOOTSTRAP_ORG_SLUG`/`BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`, idempotent via upsert, no demo fixtures.

## Config validation: centralized in `src/config.ts`, not scattered fail-at-use checks

**Before**: `DATABASE_URL` was checked once at `prisma.ts` import (effectively boot time, since `prisma.ts` is imported immediately), but `JWT_SECRET` was only checked lazily inside `authService.signingSecret()`, on the *first login attempt* — meaning a deploy missing `JWT_SECRET` would start up seemingly fine and only fail once a real user tried to log in.

**Now**: one Zod schema (`src/config.ts`) validates every required env var at process start (imported first in `server.ts`), failing with every problem listed at once rather than one at a time. `prisma.ts`, `authService.ts`, and `app.ts` were updated to read from the validated `env` object instead of `process.env` directly where they previously did their own checking.

## wayam.ai demo login accounts

Per explicit instruction, `admin@wayam.ai` / `analyst@wayam.ai` / `viewer@wayam.ai` were added to `prisma/seed.ts`'s `USERS` array as additional accounts on the Meridian org (same roles, same `DEMO_USER_PASSWORD`). These did not exist anywhere in the codebase before this session — the pre-existing, fact-matching demo accounts are the `meridian.org` ones. See `docs/engineering/GAP_AUDIT.md` for the full investigation.

## Row-level security: not adopted

**Decision**: tenant isolation stays entirely at the application layer (`src/lib/tenant.ts`'s `scope(ctx)`, threaded through every service) rather than also enforcing it with PostgreSQL row-level security policies.

**Why**: RLS earns its complexity when a database has clients the application layer can't fully control — a BI tool connecting with its own credentials, a second service with direct DB access, or an admin running ad hoc queries. This deployment has exactly one DB client: this API, through one connection pool (`src/lib/prisma.ts`), authenticated as one Postgres role. Every scoped query already passes through `scope(ctx)`, and that pattern is covered by `tests/integration/tenancy.test.ts`, which seeds two organizations and asserts cross-tenant reads 404. Adding RLS on top would mean maintaining `organizationId` policies in two places (Prisma's `where` clauses and Postgres `USING`/`WITH CHECK` clauses) that have to agree, plus `SET LOCAL` session variables set correctly on every connection from the pool — real operational surface for a guarantee the application layer already provides and already tests.

**Revisit if**: a second DB client is ever introduced (an analytics job, a BI tool, a second service) that bypasses this API's query layer. At that point RLS becomes the only backstop that client can't route around, and is worth the cost.

## Audit hash chain: a per-org, best-effort sequence

**Decision**: each `AuditEvent` row stores `hash` = SHA-256(`prevHash` + canonical row content) and `prevHash` = the previous row's `hash` for that organization, computed in `auditService.ts` and verified by walking the sequence in `GET /api/audit/verify`.

**Known limitation, accepted**: `recordAudit` reads the "latest hash for this org" and writes the new row as two separate steps, not inside a lock. Two truly concurrent writes to the same organization could both read the same prevHash and `verify` would then report a false break at that point, even though neither row was tampered with. A per-organization advisory lock around the read+insert would close this, at the cost of serializing every audited write per org. Not implemented: this product's write volume per organization doesn't justify the latency yet. Revisit if concurrent-write races start showing up in `verify` output in practice.

**Separately**, a Postgres trigger (`audit_event_immutable()`, in the `add_audit_immutability` migration) rejects any UPDATE or DELETE on `AuditEvent` outright — this is independent of the hash chain and holds even if the hash chain were somehow bypassed. Verified by `tests/integration/audit-immutability.test.ts` issuing raw SQL against the table directly.

Pre-existing audit rows (the Meridian demo data, seeded before this feature existed) had no `hash`/`prevHash` values. These were backfilled once, with the user's explicit approval, by briefly disabling the UPDATE trigger, computing the chain from each organization's first row forward, and re-enabling the trigger immediately after. No other column was touched by that backfill.

**Regression this surfaced, fixed in the same pass**: the new trigger initially broke two existing, legitimate scripts that the full test suite caught:
- `prisma/seed-demo.ts` used to `UPDATE AuditEvent.createdAt` after insert, to backdate seeded events so a fresh demo doesn't look like a burst of activity. Fixed by adding an optional `createdAt` override to `recordAudit`'s input (`src/services/auditService.ts`) so the backdated value is written at insert time instead — no UPDATE needed at all.
- `prisma/reset-demo.ts` deletes an organization's audit rows as part of a full demo reset, using an ordinary `deleteMany`.

## The DELETE exception, corrected twice

The first two attempts at letting `reset-demo.ts` delete audit rows were both wrong, and the user caught both:

**Attempt 1** (rejected): disable the trigger with raw SQL inside `reset-demo.ts`, scoped to that one `deleteMany` call. This violated `tests/integration/demo-reset.test.ts`'s own pre-existing invariant that the reset script contains **no raw SQL, no TRUNCATE, and no unscoped delete** — a test that reads the script's own source and fails if any of those strings appear. That test had apparently never actually run to completion before (see "demo-reset tests were never really exercised" below), so this violation went unnoticed until fixing the DB-name issue made the suite genuinely execute the script for the first time.

**Attempt 2** (rejected): key the trigger's DELETE exception on the row's own `Organization.slug` containing "demo" (migration `allow_demo_audit_delete`). Wrong on three counts the user identified directly:
1. The Meridian demo org's actual slug is `"meridian"` — contains no "demo" — so the exception would never have applied to the org this product actually demos with.
2. A real customer organization whose slug happens to contain "demo" (e.g. "Demographics Health") would silently lose audit immutability — the opposite of what the trigger exists to guarantee.
3. It didn't match `reset-demo.ts`'s own existing guard, which is keyed on the **database name**, not any row's content.

**Final, correct version** (migration `audit_delete_by_database_name`): the trigger function checks `current_database() ILIKE '%demo%'` — the same signal `reset-demo.ts`'s own guard and `tests/setup/globalSetup.ts`'s truncate guard already use. DELETE is permitted only when the database itself was provisioned as a demo/test database; it has no dependency on any row's or organization's content. UPDATE remains unconditionally blocked for every row, in every database, with no exception at all. `reset-demo.ts` uses a plain, typed `deleteMany` — no raw SQL anywhere in that file, verified by the source-reading test.

A `NODE_ENV=production` boot guard was added to `src/config.ts`: the process refuses to start if `DATABASE_URL`'s database name contains "demo", since that would silently disable audit immutability for whatever that database actually serves. Tested in `src/config.test.ts` by spawning a real child process per scenario (the guard runs inside a top-level `loadEnv()` call at import time, so there's no other way to exercise multiple outcomes without env bleeding between them).

## demo-reset tests were never really exercised

Earlier framing of "18 pre-existing failures, unrelated to my changes" for `demo-reset.test.ts` was itself the bug: the test database (`medguard_test`) has never contained "demo" in its name, so `reset-demo.ts`'s own guard rejected every single demo-reset test before the reset logic — including the audit-delete exception — ever ran. Treating that as an acceptable, unrelated baseline meant the actual reset path, the backup step, and the trigger exception were never verified by the suite at all, only assumed safe by code review.

**Fix**: a dedicated `vitest.demo-reset.config.ts` runs `demo-reset.test.ts` alone against a separate database (`medguard_demo_test` by default, override via `DEMO_TEST_DATABASE_URL`) whose name satisfies both guards — "test" for `globalSetup.ts`'s truncate check, "demo" for `reset-demo.ts`'s own check. `npm test` now runs both configs (`vitest run && vitest run --config vitest.demo-reset.config.ts`) so one command's exit code reflects both. `npm run test:demo-reset` runs just that file.

Running it for real surfaced one more genuine, previously-undiscovered bug: `pg_dump` rejects Prisma's `?schema=` query parameter on the connection URL (`pg_dump: error: invalid URI query parameter: "schema"`) — the backup step had never actually executed before either. Fixed in `reset-demo.ts` by stripping the query string before passing the URL to `pg_dump` (unnecessary anyway — `pg_dump` dumps every schema in the target database by default).
