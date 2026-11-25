# Operations Runbook

Operational procedures for running Drishti in production: backup/restore, secret rotation, and audit-chain integrity checks. For the deploy process itself (environments, Docker, the live Render/Vercel/Neon topology, rollback), see `DEPLOYMENT.md` at the repo root — this file complements it rather than repeating it.

## Deploy steps (summary — see `DEPLOYMENT.md` for the full procedure)

1. `prisma migrate deploy` as a release step, never on container start (the Dockerfile's `CMD` deliberately doesn't run it — see its comment).
2. Deploy the new image/build.
3. Confirm `/health` and `/health/ready` are green before routing traffic.

### Deploying this branch (Phases 1-5) to the existing Neon/Render/Vercel setup

Not done — this is what it would take, so a reviewer or deployer doesn't have to work it out from scratch:

1. Merge this branch's PR into `main` (nothing in this plan deploys automatically on merge — see `DEPLOYMENT.md`'s note that Render's GitHub App can't see the WayamAI org, so a push still needs a manual redeploy from the Render dashboard).
2. Run `prisma migrate deploy` against the Neon database (`neondb`, project `neon-bistre-ladder`) using its **direct** (non-pooled) connection string — `DEPLOYMENT.md`'s "Environment variables" section has both Neon connection strings and which one each command needs.
3. Redeploy the Render service from its Deploys tab.
4. Confirm `https://drishti-api-z92p.onrender.com/health/ready` is green, then one authenticated smoke request (e.g. `GET /api/auth/me` with a real token) — the same two checks the CI `zap` job's "Start the API in the background" step already automates locally.
5. No new required env vars this phase added — `MAILPIT_URL`/`DEMO_USER_PASSWORD`/`JWT_SECRET` are all already in Render's env per `DEPLOYMENT.md`. If Render doesn't yet have a production SMTP relay configured (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD` — see `src/services/mailer.ts`), invite/reset emails will fail to send; confirm that's configured before relying on those flows in production.

## Backup and restore (pg_dump / pg_restore)

**Tested once, on a local database, 2026-11-25** — not a procedure written from documentation, a procedure that was actually run:

```bash
# Backup
pg_dump "postgresql://$USER@localhost:5432/medguard_runbook_test" -f backup.sql

# Restore (into a fresh, empty database — pg_dump's plain-SQL output
# recreates the schema, so the target must not already have one)
psql -d <fresh-database> -f backup.sql
```

Verified: seeded the Meridian demo data (8 assets), dumped it, dropped the database, recreated an empty one, restored from the dump, and confirmed the same 8 assets with the same names (`Patient Portal`, `Pharmacy System`, `Epic EHR Core`, ...) came back. No errors in the restore output.

For a database whose `DATABASE_URL` carries Prisma's `?schema=` query parameter, strip it before passing the URL to `pg_dump`/`psql` — `pg_dump` doesn't understand that parameter and rejects the whole URL otherwise (`prisma/reset-demo.ts` hits exactly this and strips it the same way: `dbUrl.split("?")[0]`).

For the real production database (Neon), use `pg_dump --format=custom` instead of plain SQL for a large database (faster, compressed, supports parallel restore via `pg_restore -j`), and always restore into a **new** database, confirm it, then cut over — never restore directly over production.

```bash
# Production-sized backup
pg_dump --format=custom "<direct Neon connection string>" -f backup.dump

# Restore into a fresh database
pg_restore -d "<fresh target>" backup.dump
```

Neon also takes its own automatic point-in-time snapshots independent of this — check the Neon project dashboard before reaching for a manual `pg_dump` restore in a real incident; it's very likely faster.

## Rotating secrets

### `JWT_SECRET`

Rotating it **invalidates every outstanding access token immediately** (they're signed with the old secret and fail verification against the new one) but **does not invalidate refresh tokens** (they're random, stored hashed, and never touch `JWT_SECRET`). Practically: every logged-in user gets one 401 on their next request, their frontend refreshes automatically (the refresh token is still valid), and they get a new access token signed with the new secret — no forced re-login.

1. Generate a new value (32+ random characters — `openssl rand -base64 32` is fine).
2. Update it in the deploy target's env (Render's dashboard, or wherever `JWT_SECRET` lives for the environment).
3. Redeploy/restart the process so it picks up the new value (`JWT_SECRET` is read once at boot via `src/config.ts`, not re-read per request).
4. No database change, no user action needed beyond the one automatic refresh above.

### `DEMO_USER_PASSWORD`

Only affects the demo seeds' accounts (`npm run db:seed`, `db:seed:demo`), not real user accounts — rotating it means the next time a demo seed runs, new/updated demo accounts get the new password; existing demo accounts' passwords don't change retroactively unless the seed re-sets them (check the specific seed script — `seed.ts`'s accounts get it on every run since the password hash is recomputed each time; `seed-demo.ts`'s upsert-only accounts keep whatever password they already have, per `DEPLOYMENT.md`'s note that it "keeps the password it has").

### API keys (ingestion)

Not rotated in place — `POST /api/api-keys/:id/revoke` revokes immediately (checked on every ingest request, see `tests/integration/api-key-scope.test.ts`'s "a revoked key is rejected immediately" case), then `POST /api/api-keys` issues a new one. The secret is shown exactly once at creation and never again (only its hash is stored), so there is no "rotate and keep the old one working for a grace period" option by design — a connector needs the new secret before the old one is revoked, or it goes down momentarily.

## Checking audit-chain integrity

```
GET /api/audit/verify
```

ADMIN-only. Walks every `AuditEvent` row for the caller's organization in insertion order, recomputing each row's SHA-256 hash from the one before it (`prevHash` + the row's own canonical content) and comparing against what's stored. Returns:

```json
{ "data": { "intact": true, "checked": 142, "firstBrokenId": null } }
```

`intact: false` means the chain broke at `firstBrokenId` — either that row was altered directly (bypassing the application, since a DB trigger already rejects ordinary `UPDATE`/`DELETE` on this table — see `audit-immutability.test.ts`) or a row was inserted/deleted out of band with triggers disabled. This is the second, independent check beneath the trigger, for exactly that scenario — run it as part of any incident investigation where tampering is suspected, and periodically (e.g. a scheduled job hitting this endpoint) as a standing integrity check.
