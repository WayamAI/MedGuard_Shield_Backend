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

### Three seeding commands, and the difference between them

| Command | Behaviour | Safe against existing data |
|---|---|---|
| `npm run db:seed` | **TRUNCATEs every table**, then rebuilds | ❌ no |
| `npm run db:seed:demo` | Upsert-only, scoped to one organisation | ✅ yes |
| `npm run db:demo:reset` | Deletes and rebuilds **one** organisation | ✅ yes, outside that organisation |

**`npm run db:seed` truncates every table.** It is destructive by design. It
must never be pointed at production, and never at a demo database
mid-demonstration.

**`npm run db:seed:demo` is the one to reach for otherwise.** It contains no
deleteMany, TRUNCATE, DROP, raw SQL or migration reset -- there is a test that
reads its source and fails if any of those appear. Everything it writes lives
inside a single organisation looked up by slug, so a populated database gains a
demo tenant beside its existing data rather than losing any of it. Running it
repeatedly is a no-op after the first time.

```bash
npm run db:seed:demo                      # creates or tops up "Drishti Demo Healthcare"
DEMO_ORG_SLUG=meridian npm run db:seed:demo   # or target an existing organisation
```

Demo accounts are `admin@<slug>.invalid`, `analyst@<slug>.invalid` and
`viewer@<slug>.invalid`, all using `DEMO_USER_PASSWORD`. The seed never prints
the password, and an account that already exists keeps the password it has.

**`npm run db:demo:reset` returns the demo tenant to a known state.** The seed
is additive, so an estate that has been clicked around during a rehearsal keeps
whatever was added to it. This is the other half: it removes the demo
organisation's records and re-seeds them, so every demonstration starts from
the same dataset. Run it before a customer demonstration.

```bash
npm run db:demo:reset                      # rebuild "Drishti Demo Healthcare"
DEMO_ORG_SLUG=meridian npm run db:demo:reset   # or target another organisation
```

This one genuinely deletes, so the scoping is enforced rather than intended:

- Every statement carries `organizationId`, directly or through the parent that
  owns the row. There is no `TRUNCATE`, no `DROP`, no raw SQL and no unscoped
  delete -- a test reads the file's source and fails if any appear, and a
  second test fails if any `deleteMany` lacks a `where` clause.
- Rows in every *other* organisation are counted immediately before and after
  the deletions **inside the same transaction**. If one count moves, the
  transaction rolls back and nothing is deleted at all. A scoping mistake
  therefore fails loudly and changes nothing.
- It refuses to run under `NODE_ENV=production` unless
  `DEMO_RESET_ALLOW_PRODUCTION=yes` is set explicitly.
- The organisation row, the demo user accounts and their memberships are kept.
  An operator who changed the demo password would be surprised to find it
  silently reverted, and keeping the organisation keeps its id stable.
- Audit events belonging to no organisation (failed logins) are out of scope by
  definition and are left alone.

Running it repeatedly produces the same dataset: 12 assets, 5 vendors, 8
controls, 5 policies, 9 remediations, 7 threats and 13 backdated audit events,
spanning every risk band. Scores are produced by the risk engine from that
graph, not written as literals, so they are reproducible rather than fixed.

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
npm test                      # 572 tests; migrates and truncates the TEST database only
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

## Live production deployment

Deployed and verified end-to-end on 2026-09-25.

| Piece | URL / identifier |
|---|---|
| Client app (Vercel) | https://drishti-arka-s-team.vercel.app |
| API (Render) | https://drishti-api-z92p.onrender.com |
| Liveness | https://drishti-api-z92p.onrender.com/health |
| Readiness (touches Postgres) | https://drishti-api-z92p.onrender.com/health/ready |
| Database | Neon project `neon-bistre-ladder`, us-east-1, database `neondb` |

The Render hostname carries a suffix (`-z92p`) that Render assigns; it is *not*
derivable from the service name. Always read it from the service page rather
than assuming `drishti-api.onrender.com`.

Render's GitHub App cannot see the WayamAI org, so this service was created
from the **public repository URL**. The consequence is that pushes do not
auto-deploy — redeploy from the Render dashboard, or install the Render GitHub
App on the org to restore it.

Neon's database is named `neondb`, not `drishti`: the name is chosen by the
Vercel Marketplace integration that provisioned it, and overriding it would
desync the connection strings Vercel manages.

### Rollback

Render keeps previous deploys. Roll back from the service's Deploys tab by
redeploying an earlier commit; no database change is involved, because
migrations are a separate release step and none of them are destructive.

To roll the frontend back, redeploy a previous Vercel deployment from the
project's Deployments tab. Remember `VITE_API_BASE_URL` is baked in at build
time, so a rollback also rolls back the API URL it was built against.

---

## Free hosted deployment (Vercel + Render + Neon)

The demo topology. Three free tiers, each with one caveat that will cost an
hour if it is discovered rather than read:

| Piece | Host | Caveat |
|---|---|---|
| SPA | Vercel Hobby | `VITE_API_BASE_URL` is inlined at build time; changing it needs a redeploy |
| This API | Render free web service | suspends after ~15 min idle; next request waits 30-60s |
| Postgres | Neon free project | run **migrations against the direct endpoint**, not the pooled one; the compute scales to zero when idle and wakes on the next connection |

### The shape of it

```
                      client browser
                            |
                            | HTTPS
                            v
              +-----------------------------+
              |  Vercel  ·  Drishti web     |   static SPA, built by Vite
              |  medguard_shield            |   VITE_API_BASE_URL inlined at build
              +--------------+--------------+
                             |
                             | HTTPS + credentialed CORS
                             | (cookie: Secure; SameSite=None)
                             v
              +-----------------------------+
              |  Render  ·  Drishti API     |   Docker, Express, non-root
              |  render.yaml, /health probe |   reads PORT from the platform
              +--------------+--------------+
                             |
                             | Postgres over TLS (sslmode=require)
                             v
              +-----------------------------+
              |  Neon  ·  Serverless PG     |   us-east-1, to match Virginia
              +-----------------------------+
```

Three hosts, three failure modes, and they are worth telling apart before you
start debugging: Vercel serves a file that was built with whatever
`VITE_API_BASE_URL` was set at build time, so a wrong API URL is fixed by a
*rebuild* and never by an env change alone. Render holds the only secrets.
Neon is the only stateful piece.

### Environment variables

Nothing here belongs in git. Both hosts store these in their own encrypted
settings; `render.yaml` marks the secret ones `sync: false` precisely so the
blueprint prompts rather than records them.

**Render (API)**

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection URI, `?sslmode=require`. Pooled endpoint at runtime; see step 1 about migrations |
| `JWT_SECRET` | yes | 32+ random chars; the server refuses to boot without it |
| `FRONTEND_ORIGIN` | yes | exact Vercel origin, no trailing slash, comma-separated for several |
| `NODE_ENV` | yes | `production` — this is what turns on `Secure; SameSite=None` |
| `PORT` | set by `render.yaml` | `4000`; the server reads whatever the platform injects |

`DEMO_ORG_SLUG`, `DEMO_ORG_NAME`, `DEMO_USER_DOMAIN` and `DEMO_USER_PASSWORD`
are read only by the seed scripts, which run from a workstation. The API
process never reads them, so they do not belong on the service.

**Vercel (web)**

| Variable | Required | Value |
|---|---|---|
| `VITE_API_BASE_URL` | yes | the Render origin, e.g. `https://<service>.onrender.com` |

Build-time, not runtime. `src/lib/apiClient.ts` throws if it is unset rather
than silently falling back to localhost, so a misconfigured build fails loudly
in the browser instead of looking like a backend outage.

`render.yaml` in this repo is the service definition. Render reads it as a
Blueprint, so the topology is reviewable rather than buried in dashboard state.

### Order of operations

Each step produces something the next one needs, so the order is not
negotiable.

**1. Neon project.** Create the database (name it `drishti`) and take the
connection URI from the project dashboard. Neon hands out two endpoints for the
same database and the difference matters:

| Endpoint | Host contains | Use it for |
|---|---|---|
| Pooled | `-pooler` | the running API — PgBouncer, many short-lived connections |
| Direct | no `-pooler` | `prisma migrate deploy` |

Run **migrations against the direct endpoint**. Neon's pooled endpoint is
PgBouncer in transaction mode, which does not hold the session-level advisory
lock `prisma migrate` takes to serialise migrations; pointed at the pooler a
migration can hang or fail in ways that do not name the cause. The running API
is the opposite case and belongs on the pooler, because serverless Postgres
charges you for idle connections held open.

Both URIs need `?sslmode=require`. Neon refuses plaintext.

**2. Migrate and seed, from a workstation.** Not from the API container — see
the Dockerfile's `CMD` comment for why a booting container must not migrate.
Pass `DATABASE_URL` inline so a local `.env` cannot leak into a hosted
database:

```bash
DATABASE_URL='<neon-direct-uri>' npx prisma migrate deploy
DATABASE_URL='<neon-direct-uri>' DEMO_USER_PASSWORD='<8+ chars>' npm run db:seed:demo
```

`db:seed:demo`, never `db:seed` — the latter truncates every table. The safe
seed creates `admin@drishti-demo.invalid`, `analyst@…` and `viewer@…` with that
password.

**3. Render service.** New > Blueprint. Render's GitHub App cannot see the
WayamAI org, so use the **Public Git Repository** field at the bottom of the
repo picker rather than the connected-repo list:

```
https://github.com/WayamAI/MedGuard_Shield_Backend
```

The trade-off is that a repo added this way gets no auto-deploy on push;
redeploy by hand, or install the Render GitHub App on the org later.

Render then prompts for exactly **one** value:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon **pooled** URI from step 1 — the API runs on the pooler, only migrations use the direct endpoint |

`JWT_SECRET` is `generateValue: true`, so Render mints it and no human ever
sees it. `FRONTEND_ORIGIN` is committed in `render.yaml` as a plain value,
because a public origin is not a secret and belongs in review rather than in
dashboard state.

**4. Verify the API before touching the frontend.**

```bash
curl -s https://<service>.onrender.com/health        # process up
curl -s https://<service>.onrender.com/health/ready  # database reachable
```

`/health/ready` failing while `/health` passes means the service is up and the
database is not — almost always a missing `sslmode=require`, or a `DATABASE_URL`
whose password was truncated when it was pasted.

**5. Deploy the frontend, then close the CORS loop.** Set
`VITE_API_BASE_URL` to the Render URL in the Vercel project and deploy, then
set `FRONTEND_ORIGIN` on Render to the exact Vercel production origin and
redeploy the API.

Skipping the second half is the single most common failure here, and it
misleads: `POST /api/auth/login` succeeds, so the credentials look fine, and
then the browser blocks every subsequent call. CORS in `src/app.ts` is an exact
allowlist and never a wildcard, because `credentials: true` makes `*` invalid
anyway. Vercel preview URLs carry a random hash and will not match unless you
list them individually.

### Keeping the free tiers awake

Both free tiers sleep, and they sleep for different reasons, so one ping has to
satisfy both:

- Render suspends the **service** after ~15 minutes without inbound traffic,
  and the next request pays a 30-60s cold start.
- Neon scales the **compute** to zero when idle. That one is far less
  painful — it wakes on the next connection, not on a human's patience — but it
  is still a first-query latency the keepalive removes.

A ping against `/health` would wake only the first — it is a static handler and
never opens a connection, so the Neon compute stays asleep behind a perfectly
warm API. `/health/ready` runs `SELECT 1`, which is what keeps both ends alive.
It sits outside the `/api` auth gate on purpose: a probe that needs a token
cannot be called by the platform deciding whether to route to the instance.

Render's own health check is pointed at `/health`, not `/health/ready`, and
deliberately: Render restarts an instance whose check fails, and a database blip
should not kill a healthy container.

`.github/workflows/keepalive.yml` does exactly this, every 10 minutes. It reads
the repository variable `DRISHTI_API_URL` (Settings > Secrets and variables >
Actions > Variables) and skips rather than fails while that is unset, so it is
inert until there is something to keep alive. A variable and not a secret: the
hostname is public, and a secret would be masked in the logs precisely when
reading them matters. The tradeoff is real rather than free: an always-awake
service consumes the free tier's 750 instance-hours a month more or less
continuously, which covers exactly one service.

---

## Verified

Against `deploy/production-launch`, on 2026-09-24:

| Check | Result |
|---|---|
| `npm run build` | pass |
| `npm run typecheck` (src + tests) | pass |
| `npm run lint` | pass |
| `npx prisma validate` | pass |
| `npm test` | 572/572 pass |
| `docker build` | pass |
| Container honours an injected `PORT` | pass — booted on `PORT=10000`, not the `EXPOSE`d 4000 |
| Container serves `/health` | pass |
| Container serves `/health/ready` against real Postgres | pass — `{"status":"ready"}` |
| Docker healthcheck | reports `healthy` |
| `/health` reports the real version | pass — see the regression note below |

The container checks were run against a throwaway `postgres:17-alpine` on a
private Docker network, which is the closest local analogue to how Render runs
the image: an unprivileged process, no `.env` file, every value injected.

### A note on test flakiness

`npm test` is not perfectly deterministic. Across three clean full runs on
2026-09-24 it produced 571/571, 570/571 and 572/572 — the single failure was
`import.test.ts`, whose login helper received an empty response body. The same
class of failure has been seen before in `permissions.test.ts`.

What is known:

- It does not reproduce in isolation. `import.test.ts` (56 tests) and
  `permissions.test.ts` (123 tests) both pass every time when run alone.
- It is not cross-file database contention by parallelism: `vitest.config.ts`
  sets `fileParallelism: false`, so files already run one at a time.
- It is not the rate limiter leaking between files. `createLoginLimiter()` is
  a per-`createApp()` factory, so each file gets its own budget.
- It is a failure to *obtain* a session in a test helper, not an authorization
  decision going the wrong way. No test has ever observed a denied caller being
  allowed through.

What is not known: the actual trigger. It is recorded here rather than papered
over, and no test or authorization rule has been weakened to make the suite
green. Treat a red run as "re-run and check whether the same test failed",
not as a release gate on its own.

Not verified, and not claimed: horizontal scaling, managed backup/restore, and
load behaviour under concurrent users.
