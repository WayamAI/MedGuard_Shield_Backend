# MedGuard — Demo Runbook

Go/no-go procedure for running the MedGuard demo. Follow it in order from a cold
terminal. The whole thing takes about a minute.

- **Backend** — `medguard-backend`, port **4000**
- **Frontend** — `medguard-shield-main`, port **8080** (not negotiable, see step 4)
- **Database** — local Postgres 14, database `medguard_dev`

---

## Step 0 — Install dependencies

**Run this before anything else on a machine that has not run the demo before,
and after any `git pull`.** Nothing from step 3 onward works without it, and the
failure is not obvious: `npm run dev` exits with a module-resolution error
rather than anything that mentions installing.

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend"
npm install
npm install-scripts approve prisma @prisma/engines esbuild   # npm 11+ blocks these by default
npm install                                                   # re-run so the approved scripts execute
npx prisma generate                                           # emits the client into src/generated/prisma

cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-shield-main"
npm install
```

Two of those are easy to skip and both fail confusingly — see `README.md` →
*Fresh-clone gotchas* for the full explanation:

- Without the `install-scripts approve` step, `npm install` reports success but
  never downloads the Prisma query engine, so every `prisma` command fails.
- `npx prisma generate` is required after every clone and after any change to
  `prisma/schema.prisma`; `src/generated/` is gitignored and not in the repo.

If the database has never been created on this machine, also run
`npx prisma migrate dev` then `npx prisma db seed` from the backend directory.

> Use `npm`, not `bun`, for the frontend. The checkout path contains a space
> (`Wayam AI`), which trips a bun bug (`CouldntReadCurrentDirectory`).

Already installed and only rehearsing? Skip to step 1.

---

## Step 1 — Check nothing is already listening

**Do this first, every time.** Earlier testing can leave a *detached* server still
holding port 4000 — one whose parent shell was closed or reaped, so it has no
terminal, no visible logs, and no clean way to stop it. It answers requests
normally, which is what makes it dangerous: it may be serving **stale code** and
looks identical to a healthy server until the demo goes wrong.

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

No output means the port is free — continue to step 2.

`-sTCP:LISTEN` is not optional. A bare `lsof -i :8080` also lists *client*
connections **to** that port — including your own browser. On a machine with the
demo open in Chrome it prints rows like:

```
Google    1016 arkabera   52u  IPv6 ...  TCP localhost:51713->localhost:http-alt (ESTABLISHED)
node     19832 arkabera   13u  IPv6 ...  TCP *:http-alt (LISTEN)
```

Only the `(LISTEN)` row is the server. Killing the PID from the Chrome row kills
the browser you are about to present in. `-nP` also prints real port numbers;
without it macOS substitutes service names and 4000 shows up as `terabase`,
8080 as `http-alt`, which is easy to misread as the wrong process.

To kill whatever holds the port, without reading PIDs at all:

```bash
kill $(lsof -nP -iTCP:4000 -sTCP:LISTEN -t)
kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t)
```

If a process ignores a plain `kill`, escalate with `kill -9 <pid>`.

**Re-run both `lsof` commands and confirm they are silent before continuing.**

---

## Step 2 — Confirm Postgres is up

```bash
pg_isready
```

Expect `accepting connections`. If it is down:

```bash
brew services start postgresql@14
```

---

## Step 3 — Start the backend (terminal 1)

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend"
npm run dev
```

Expect exactly:

```
[medguard] API listening on http://localhost:4000
[medguard] CORS origin: http://localhost:8080
```

Leave this terminal open. Errors here mean a missing `.env`, or that step 0 was skipped — see
`README.md` → Fresh-clone gotchas.

---

## Step 4 — Start the frontend (terminal 2)

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-shield-main"
npm run dev
```

Expect `Local: http://localhost:8080/`.

> **If it says 8081, stop and go back to step 1.**
> Vite silently falls back to the next free port when 8080 is taken. The backend
> pins its allowed CORS origin to `http://localhost:8080` via `FRONTEND_ORIGIN`,
> so a frontend on 8081 gets every request rejected. The symptom is the worst
> kind: the UI loads and looks fine, but no data ever appears.

---

## Step 5 — Go/no-go verification (terminal 3)

Copy-paste this whole block. It is the pre-demo gate, not a dev-time convenience.

> **Do not run this while screen-sharing.**
>
> `set -a; . ./.env; set +a` exports every variable in `.env` into the shell for
> the rest of that session — including `DEMO_USER_PASSWORD` and `JWT_SECRET`.
> Nothing is printed by this block itself, but any later `env`, `export`, `set`,
> or a shell prompt that expands variables will put both on screen in front of
> the audience. `JWT_SECRET` is the key that signs every session token: anyone
> who reads it can mint a valid token for any user.
>
> Run this in a terminal you are **not** sharing, before the call starts. If you
> must verify mid-call, use a subshell so nothing persists, and remember it still
> reads the file:
>
> ```bash
> ( set -a; . ./.env; set +a; curl -s http://localhost:4000/health )
> ```
>
> If you have already sourced it in a shared terminal, `unset DEMO_USER_PASSWORD
> JWT_SECRET` clears both from that session.

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend"
set -a; . ./.env; set +a

echo "--- 1. health ---"
curl -s http://localhost:4000/health; echo

echo "--- 2. auth gate is live (must be 401) ---"
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4000/api/assets

echo "--- 3. login ---"
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"'"$DEMO_USER_PASSWORD"'"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
[ -n "$TOKEN" ] && echo "token acquired" || echo "LOGIN FAILED"

echo "--- 4. Sankey has all three tones ---"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/dataflows \
  | python3 -c "import json,sys,collections;d=json.load(sys.stdin)['data'];print(collections.Counter(f['status'] for f in d))"

echo "--- 5. Risk matrix has all five bands ---"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/risks \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(sorted({r['band'] for r in d}))"

echo "--- 6. row counts match a full seed ---"
for pair in assets:8 dataflows:10 risks:8 vendors:5; do
  ep=${pair%%:*}; want=${pair##*:}
  got=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:4000/api/$ep" \
    | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']))")
  [ "$got" = "$want" ] && echo "  $ep: $got OK" || echo "  $ep: $got EXPECTED $want <-- RESEED"
done
```

### Expected output — anything else is a no-go

```
--- 1. health ---
{"status":"ok"}
--- 2. auth gate is live (must be 401) ---
401
--- 3. login ---
token acquired
--- 4. Sankey has all three tones ---
Counter({'warn': 5, 'ok': 3, 'violation': 2})
--- 5. Risk matrix has all five bands ---
['CRITICAL', 'EXTREME', 'HIGH', 'LOW', 'MODERATE']
--- 6. row counts match a full seed ---
  assets: 8 OK
  dataflows: 10 OK
  risks: 8 OK
  vendors: 5 OK
```

The three module endpoints return an object rather than an array, so they are
checked separately:

```bash
echo "--- 7. module endpoints ---"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/access \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(f\"  access:  {d['summary']['total']} grants, {d['summary']['flagged']} flagged\")"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/threats \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(f\"  threats: {d['summary']['total']} total, {d['summary']['open']} open, {d['summary']['openCritical']} open critical\")"
```

```
--- 7. module endpoints ---
  access:  9 grants, 6 flagged
  threats: 5 total, 3 open, 2 open critical
```

Checks 4, 5 and 6 are the ones that matter. They assert the facts the demo
visually depends on — that the Sankey can render all three ribbon tones, that
the risk matrix is spread across all five bands rather than clumped, and that a
full set of rows is present. A server can be perfectly healthy and still fail
these if the data was wiped or partially seeded.

Checks 6 and 7 cover assets, data flows, risks, vendors, access grants and
threats — everything the two visualisations
read. It does **not** assert the 3 seeded user rows or the 1-8 asset id range;
neither is exposed through the API. Confirm those directly if you need them:

```bash
psql -d medguard_dev -c 'SELECT COUNT(*) FROM "User";'           # expect 3
psql -d medguard_dev -c 'SELECT MIN(id), MAX(id) FROM "Asset";'  # expect 1 | 8
psql -d medguard_dev -c 'SELECT COUNT(*) FROM "Identity";'       # expect 6
```

### Reading a failure

| Symptom | Cause | Fix |
|---|---|---|
| health check hangs or connection refused | backend not running | step 3 |
| check 2 returns 200 instead of 401 | stale pre-auth build on the port | step 1, then step 3 |
| `LOGIN FAILED` | database not seeded, or `.env` missing `DEMO_USER_PASSWORD` | see Data reset below |
| check 4 missing a tone / check 5 missing a band | data wiped or partially seeded | `npx prisma db seed` |
| UI loads but shows no data | frontend on 8081, CORS rejecting | step 1, restart frontend on 8080 |
| logged out unexpectedly mid-demo | the page was reloaded and the client does not use the session cookie | sign in again, and avoid reload (see Demo credentials) |

---

## Data reset

| Command | Use when |
|---|---|
| `npx prisma db seed` | **Default.** Data looks wrong, partial, or edited during a rehearsal. Wipes and rebuilds all rows. Idempotent, and keeps primary keys stable so any saved link still resolves. Takes about a second. |
| `npx prisma migrate reset --force` | **Last resort.** The schema itself is wrong or migrations are out of sync. Drops the database, re-runs every migration, then reseeds. Destroys everything in `medguard_dev`. |

Both are safe to run against `medguard_dev` — it holds nothing but seeded
fixtures. Re-run step 5 afterwards.

> `npx prisma db seed` is exercised constantly and is known good.
> `npx prisma migrate reset --force` is **documented but not exercised here**:
> Prisma's CLI refuses to run it on an agent's say-so and demands explicit human
> confirmation, which is the correct behaviour for a command that drops a
> database. Run it yourself, and never point it at anything but `medguard_dev`.
> Verify the target first with `grep DATABASE_URL .env`.

---

## Demo credentials

All three accounts share the password in `DEMO_USER_PASSWORD` in the backend `.env`.

| Email | Role |
|---|---|
| `admin@meridian.org` | ADMIN |
| `f.alrashid@meridian.org` | ANALYST |
| `a.patel@meridian.org` | VIEWER |

A login is valid for 8 hours. There is no refresh-token flow, so after that a
fresh sign-in is required.

**Whether a session survives a page reload is decided by the client, not by this
API.** `/api/auth/login` returns the token in the response body *and* sets it as
a persistent httpOnly cookie, and `requireAuth` accepts either:

```
Set-Cookie: medguard_token=...; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax
```

Verified against a running server — a request carrying only that cookie and no
`Authorization` header returns 200:

```bash
curl -s -c /tmp/c.txt -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"'"$DEMO_USER_PASSWORD"'"}' > /dev/null
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/c.txt http://localhost:4000/api/assets   # 200
curl -s -o /dev/null -w '%{http_code}\n'              http://localhost:4000/api/assets   # 401
```

So:

- A client that relies on the **cookie** keeps its session across a reload, for
  the full 8 hours.
- A client that holds the token **in memory** and does not send the cookie loses
  its session on reload, and lands back on the login screen.

Which path the MedGuard frontend takes is a frontend concern and is not asserted
here. **Confirm it before presenting** — sign in, press reload once, and see
whether you stay signed in. If you do not, avoid the browser's reload and address
bar during the demo and move between screens using the sidebar.

---

## Shutting down

```bash
# Ctrl-C in terminals 1 and 2, then confirm the ports actually released:
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

Both silent means a clean stop. If either still shows a process, it detached —
`kill <pid>`.
