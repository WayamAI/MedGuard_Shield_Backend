# MedGuard Backend

PHI risk-intelligence API for the MedGuard demo. Node + TypeScript + Express +
Prisma + Postgres.

## Setup

```bash
cp .env.example .env      # then set DATABASE_URL
npm install
npm install-scripts approve prisma @prisma/engines esbuild   # npm 11+ blocks these by default
npx prisma generate       # emits the client into src/generated/prisma (gitignored)
npx prisma migrate dev    # create schema
npx prisma db seed        # load the Meridian Health demo dataset
npm run dev               # http://localhost:4000
```

## Demo day: startup procedure

### 0. Check nothing stale is already listening

Testing sessions can leave a detached server holding a port. Always check first —
a stale process serves *old code* and looks identical to a healthy one.

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN    # backend
lsof -nP -iTCP:8080 -sTCP:LISTEN    # frontend
```

No output means the port is free. If either prints a row, kill that PID before
starting:

```bash
kill $(lsof -nP -iTCP:4000 -sTCP:LISTEN -t)
kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t)
```

Re-run the `lsof` checks and confirm both are silent before continuing.

### 1. Postgres

```bash
pg_isready                          # expect: accepting connections
```

If it is down: `brew services start postgresql@14`

### 2. Backend — terminal 1

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend"
npm run dev
```

Expect:

```
[medguard] API listening on http://localhost:4000
[medguard] CORS origin: http://localhost:8080
```

### 3. Frontend — terminal 2

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-shield-main"
npm run dev
```

Expect `Local: http://localhost:8080/`. **If it says 8081, stop** — something is
still on 8080 and CORS will reject the frontend, because FRONTEND_ORIGIN pins the
allowed origin to port 8080. Go back to step 0.

### 4. Verify before presenting — terminal 3

```bash
# health
curl -s http://localhost:4000/health
# expect: {"status":"ok"}

# auth gate is live
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4000/api/assets
# expect: 401

# log in and exercise the two demo endpoints
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"'"$DEMO_USER_PASSWORD"'"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/dataflows \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];import collections;print(collections.Counter(f['status'] for f in d))"
# expect: Counter({'warn': 5, 'ok': 3, 'violation': 2})  <- all three Sankey tones

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/risks \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(sorted({r['band'] for r in d}))"
# expect: ['CRITICAL', 'EXTREME', 'HIGH', 'LOW', 'MODERATE']  <- all five matrix bands
```

### 5. If the data looks wrong

Reseeding is safe and idempotent, and keeps primary keys stable:

```bash
npx prisma db seed
```

### Reset everything

```bash
kill $(lsof -nP -iTCP:4000 -sTCP:LISTEN -t) 2>/dev/null
kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t) 2>/dev/null
npx prisma migrate reset --force     # drops, remigrates, reseeds
```

## Fresh-clone gotchas

Two steps in the block above are not optional, and both fail in ways that do not
obviously point at the cause.

**1. `npm install-scripts approve prisma @prisma/engines esbuild` — before anything else works.**

npm 11 blocks package install scripts by default. Without the approval, `npm install`
reports success but never downloads the Prisma query engine or the esbuild binary, so
`node_modules/.bin` comes up empty and every `prisma` and `vitest` command fails. The
only hint is a `npm warn install-scripts` line buried in the install output:

```
npm warn install-scripts 3 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   prisma@7.10.0 (preinstall: node scripts/preinstall-entry.js)
npm warn install-scripts   @prisma/engines@7.10.0 (postinstall: node scripts/postinstall.js)
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
```

Run the approve command, then `npm install` again.

**2. `npx prisma generate` — required after every clone.**

The Prisma client is generated output, so `src/generated/` is gitignored and is *not*
in the repo. Skipping this step fails at import time, not at install time:

```
Cannot find module '.../src/generated/prisma/client.js'
```

Re-run it whenever `prisma/schema.prisma` changes, too.

### Why the URL is not in schema.prisma

Prisma 7 no longer reads the connection URL from `schema.prisma`. It comes from
`prisma.config.ts` for CLI commands (migrate, seed) and from the `@prisma/adapter-pg`
driver adapter in `src/lib/prisma.ts` at runtime — both off the same `DATABASE_URL`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch` on `src/server.ts` |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | run the compiled build |
| `npm test` | vitest (risk engine unit tests) |
| `npx prisma db seed` | reseed (idempotent — wipes and rebuilds) |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness — `{ "status": "ok" }` · **public** |
| POST | `/api/auth/login` | email + password → JWT · **public** |
| POST | `/api/auth/logout` | clears the session cookie · **public** |
| GET | `/api/auth/me` | the current `{ id, email, role }` |
| GET | `/api/assets` | asset inventory with current risk score/band |
| GET | `/api/assets/:id` | one asset: PHI types, risk breakdown, in/outbound flows |
| GET | `/api/dataflows` | Sankey-shaped flows (`source`, `target`, `phiType`, `recordsPerDay`, `encrypted`, `status`) |
| GET | `/api/risks` | matrix-shaped risks (`likelihood`, `impact`, `band`, `assetName`) |
| POST | `/api/risks/:assetId/recompute` | re-score an asset from its stored inputs |

Every route under `/api` except `/api/auth/login` and `/api/auth/logout` requires a
session. `/health` is deliberately mounted outside `/api` so the gate never applies
to it.

Success bodies are `{ "data": ... }`; errors are `{ "error": { "code", "message" } }`.

## Authentication

B6 offered Supabase Auth or Clerk. Both need an account and API keys that could not
be created here, so this is the self-contained equivalent: bcrypt password hashes in
the `User` table, and a signed JWT carrying `{ id, email, role }`.

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"<DEMO_USER_PASSWORD>"}'
```

The token comes back in the response body *and* as an httpOnly `medguard_token`
cookie, so a browser client can use `credentials: 'include'` and never touch the
token itself, while a script client can send `Authorization: Bearer <token>`.
`requireAuth` accepts either.

Seeded accounts — all three share `DEMO_USER_PASSWORD`:

| Email | Role |
|---|---|
| `admin@meridian.org` | ADMIN |
| `f.alrashid@meridian.org` | ANALYST |
| `a.patel@meridian.org` | VIEWER |

`requireRole(["ADMIN", "ANALYST"])` from `src/middleware/auth.ts` is ready for
role-gated routes; nothing uses it yet because every current endpoint is a read
any signed-in role may perform.

### Swapping in a provider later

`requireAuth` depends on exactly one thing: `verifyToken(token)` returning an
`AuthUser`. Moving to Supabase or Clerk means reimplementing that one function
against their SDK and deleting the login route — no route handler changes.

### Flow status

`/api/dataflows` derives a `status` per flow for the Sankey's ribbon tone:

| Condition | status |
|---|---|
| `encrypted && mfaEnabled` | `ok` |
| `encrypted && !mfaEnabled` | `warn` |
| `!encrypted` | `violation` |

A flow has no MFA setting of its own, so `mfaEnabled` is read off the **target**
asset — the system the records land in.

## Risk scoring

`score = likelihood × impact × exposure × controlGap / 625 × 100`, each input 1–5.

Bands: ≤20 LOW · ≤40 MODERATE · ≤60 HIGH · ≤80 CRITICAL · >80 EXTREME.

The curve is steep by construction — a product of four factors means 4/4/4/3
lands at 30.72, and EXTREME needs a raw product of 506+, effectively all 5s.
`src/services/riskEngine.ts` is the entry point callers import. The maths itself
sits in `src/services/riskScoring.ts`, which imports no database — that is what
makes it unit-testable without Postgres. riskEngine re-exports all of it and adds
the DB-bound `recomputeAssetRisk`. The seed derives its stored scores from the
same function, so seeded rows and recomputed rows agree by construction.

## Not implemented yet

Authentication (deferred for the demo — every `/api/*` route is currently
open), multi-tenancy, and the vendor module.
