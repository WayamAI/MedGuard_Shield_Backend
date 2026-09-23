# Drishti Backend — Deployment

Four environments, deliberately separated, plus how to run the API in each.

The backend runs **independently of the frontend**. It needs Postgres and
nothing else; there is no build-time or runtime dependency on the client.

---

## Environments

| Environment | Database | Seeded? | Migrations |
|---|---|---|---|
| development | `DATABASE_URL` → `medguard_dev` | yes, freely | `prisma migrate dev` |
| test | `TEST_DATABASE_URL` → `*test*` | fixture per test | automatic in `globalSetup` |
| demo | `DATABASE_URL` → a demo database | yes, deliberately | `prisma migrate deploy` |
| production | `DATABASE_URL` → production | **never** | `prisma migrate deploy`, release step |

### The one rule that matters

**`npm run db:seed` truncates every table.** It is how the demo dataset is
built, and it is destructive by design. It must never be pointed at
production, and never at a demo database mid-demonstration.

The test database has two independent guards, because the test fixtures
truncate on every `beforeEach`:

1. `vitest.config.ts` overrides `DATABASE_URL` with `TEST_DATABASE_URL` for the
   whole run, so a test can never reach the development database even if the
   shell has one exported.
2. `tests/setup/globalSetup.ts` refuses to start unless the target database
   name matches `/test/i`.

`prisma migrate reset` is not used anywhere and is not needed. (It also
refuses to run under an AI agent, which is how it should be.)

---

## Local development

```bash
cp .env.example .env          # fill in JWT_SECRET and DEMO_USER_PASSWORD
createdb medguard_dev
npm ci
npx prisma generate
npm run db:deploy             # apply migrations
npm run db:seed               # OPTIONAL — truncates, then loads demo data
npm run dev                   # tsx watch on :4000
```

Verify:

```bash
curl -s localhost:4000/health
# {"status":"ok","service":"drishti-api","version":"0.3.0"}
```

## Tests

```bash
createdb medguard_test
npm test                      # 361 tests; migrates and truncates the TEST database only
```

## Docker

```bash
cp .env.example .env          # POSTGRES_PASSWORD and JWT_SECRET are required
docker compose up --build -d
docker compose run --rm migrate       # apply migrations (tools profile)
curl -s localhost:4000/health
```

Compose waits on the Postgres healthcheck — which names the user and database
rather than calling bare `pg_isready`, because the latter reports ready before
the database exists — so the API never starts against a half-booted server.

The `migrate` service is behind the `tools` profile and is **not** part of
`up`. That is deliberate: a container that migrates as it boots races every
other replica during a rolling deploy.

## Staging / production

Build and push:

```bash
docker build -t <registry>/drishti-api:<sha> .
docker push <registry>/drishti-api:<sha>
```

Release, in this order:

1. **Migrate** — run `npx prisma migrate deploy` once, as a job, against the
   target database. Not from an application container.
2. **Deploy** — roll out the new image. It runs `node dist/server.js` and does
   not touch migrations.
3. **Verify** — `GET /health` (public, no token) and one authenticated call.

Required environment:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres. Session pooler, not transaction pooler, if hosted. |
| `JWT_SECRET` | 32+ random chars. Rotating it invalidates access tokens immediately; refresh tokens survive. |
| `FRONTEND_ORIGIN` | Exact origin(s), comma-separated. Never a wildcard — credentials are enabled. |
| `NODE_ENV=production` | **Required.** Turns on `Secure` + `SameSite=None` cookies. |
| `PORT` | Defaults to 4000. |

`DEMO_USER_PASSWORD` is only read by the seed. Production has no seeded account.

### Cookies across domains

With `NODE_ENV=production` the session cookies are `Secure; SameSite=None`,
which is what allows the API and the app to sit on different domains — and
which **requires HTTPS on both**. Over plain HTTP in production the browser
will silently drop the cookie and every request will look unauthenticated.
That failure mode has no console warning; if logins appear to succeed and then
every call returns 401, check this first.

---

## Verified

Against commit `0f63e9e`, on 2026-09-22:

| Check | Result |
|---|---|
| `npm run build` | pass |
| `npm run typecheck` (src + tests) | pass |
| `npm run lint` | pass |
| `npm test` | 361/361 pass |
| `docker build` | pass |
| Container serves `/health` | pass |
| Container serves authenticated API against real data | pass |
| Docker healthcheck | reports `healthy` |

Not verified, and not claimed: a real staging or production deploy, TLS
termination, horizontal scaling, and managed backup/restore. No such
environment was available from this session.
