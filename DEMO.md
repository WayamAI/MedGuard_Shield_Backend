# Demo quickstart

## Local (no Docker)

1. Postgres running locally, `.env` with `DATABASE_URL` pointing at a database
   whose name contains "demo", and `DEMO_USER_PASSWORD` set.
2. `npm run db:migrate` (first time only).
3. `npm run db:seed:demo` — idempotent, safe to re-run, non-destructive.
4. `npm run dev` — API on `http://localhost:4000` (or `$PORT`).
5. Sign in: `admin@<DEMO_ORG_SLUG>.invalid`, `analyst@<DEMO_ORG_SLUG>.invalid`,
   `viewer@<DEMO_ORG_SLUG>.invalid` (default slug `drishti-demo`), password
   from `DEMO_USER_PASSWORD`.
6. Between rehearsals: `npm run db:demo:reset` — takes its own `pg_dump`
   backup to `prisma/backups/` before touching anything, then scopes every
   delete to the demo organisation only, then reseeds.

## Docker

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d
docker compose -f docker-compose.yml -f docker-compose.demo.yml run --rm migrate
docker compose -f docker-compose.yml -f docker-compose.demo.yml run --rm seed-demo
```

`docker-compose.demo.yml` only overrides what the demo needs (a "demo"-named
database and non-production `NODE_ENV`, so the seed/reset safety guards don't
refuse to run) — it does not change or replace `docker-compose.yml`, which
remains the normal dev stack.

## Safety guards in place

- `seed-demo.ts` and `reset-demo.ts` both refuse to run when
  `NODE_ENV=production`, unless an explicit `*_ALLOW_PRODUCTION=yes` override
  is set.
- `reset-demo.ts` additionally refuses to run against a database whose name
  does not contain "demo" (override: `DEMO_RESET_ALLOW_ANY_DB=yes`), and takes
  a `pg_dump` backup before any delete (skip only with
  `DEMO_RESET_SKIP_BACKUP=yes`, for CI).
- `reset-demo.ts` deletes are scoped to the demo organisation by id, and a
  before/after census of every other organisation's rows runs inside the same
  transaction — any drift rolls the whole thing back.
