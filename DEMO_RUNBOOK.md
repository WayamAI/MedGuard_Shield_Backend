# MedGuard — Demo Runbook

Go/no-go procedure for running the MedGuard demo. Follow it in order from a cold
terminal. The whole thing takes about a minute.

- **Backend** — `medguard-backend`, port **4000**
- **Frontend** — `medguard-shield-main`, port **8080** (not negotiable, see step 4)
- **Database** — local Postgres 14, database `medguard_dev`

---

## Step 0 — Check nothing is already listening

**Do this first, every time.** Earlier testing can leave a *detached* server still
holding port 4000 — one whose parent shell was closed or reaped, so it has no
terminal, no visible logs, and no clean way to stop it. It answers requests
normally, which is what makes it dangerous: it may be serving **stale code** and
looks identical to a healthy server until the demo goes wrong.

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

No output means the port is free — continue to step 1.

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

## Step 1 — Confirm Postgres is up

```bash
pg_isready
```

Expect `accepting connections`. If it is down:

```bash
brew services start postgresql@14
```

---

## Step 2 — Start the backend (terminal 1)

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend"
npm run dev
```

Expect exactly:

```
[medguard] API listening on http://localhost:4000
[medguard] CORS origin: http://localhost:8080
```

Leave this terminal open. Errors here mean a missing `.env` — see
`README.md` → Fresh-clone gotchas.

---

## Step 3 — Start the frontend (terminal 2)

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-shield-main"
npm run dev
```

Expect `Local: http://localhost:8080/`.

> **If it says 8081, stop and go back to step 0.**
> Vite silently falls back to the next free port when 8080 is taken. The backend
> pins its allowed CORS origin to `http://localhost:8080` via `FRONTEND_ORIGIN`,
> so a frontend on 8081 gets every request rejected. The symptom is the worst
> kind: the UI loads and looks fine, but no data ever appears.

---

## Step 4 — Go/no-go verification (terminal 3)

Copy-paste this whole block. It is the pre-demo gate, not a dev-time convenience.

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
for pair in assets:8 dataflows:10 risks:8; do
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
```

Checks 4, 5 and 6 are the ones that matter. They assert the facts the demo
visually depends on — that the Sankey can render all three ribbon tones, that
the risk matrix is spread across all five bands rather than clumped, and that a
full set of rows is present. A server can be perfectly healthy and still fail
these if the data was wiped or partially seeded.

Check 6 covers assets, data flows and risks — everything the two visualisations
read. It does **not** assert the 3 seeded user rows or the 1-8 asset id range;
neither is exposed through the API. Confirm those directly if you need them:

```bash
psql -d medguard_dev -c 'SELECT COUNT(*) FROM "User";'           # expect 3
psql -d medguard_dev -c 'SELECT MIN(id), MAX(id) FROM "Asset";'  # expect 1 | 8
```

### Reading a failure

| Symptom | Cause | Fix |
|---|---|---|
| health check hangs or connection refused | backend not running | step 2 |
| check 2 returns 200 instead of 401 | stale pre-auth build on the port | step 0, then step 2 |
| `LOGIN FAILED` | database not seeded, or `.env` missing `DEMO_USER_PASSWORD` | see Data reset below |
| check 4 missing a tone / check 5 missing a band | data wiped or partially seeded | `npx prisma db seed` |
| UI loads but shows no data | frontend on 8081, CORS rejecting | step 0, restart frontend on 8080 |
| logged out unexpectedly mid-demo | the page was reloaded; the token is in memory only | sign in again, and avoid reload (see Demo credentials) |

---

## Data reset

| Command | Use when |
|---|---|
| `npx prisma db seed` | **Default.** Data looks wrong, partial, or edited during a rehearsal. Wipes and rebuilds all rows. Idempotent, and keeps primary keys stable so any saved link still resolves. Takes about a second. |
| `npx prisma migrate reset --force` | **Last resort.** The schema itself is wrong or migrations are out of sync. Drops the database, re-runs every migration, then reseeds. Destroys everything in `medguard_dev`. |

Both are safe to run against `medguard_dev` — it holds nothing but seeded
fixtures. Re-run step 4 afterwards.

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

The session token is held **in memory only** — never in localStorage or
sessionStorage — so it is deliberately not persistent:

| Action | Effect |
|---|---|
| Navigating inside the app (sidebar links) | session kept |
| **Reloading the page, or opening the app in a new tab** | **session lost, back to login** |
| Closing the tab | session lost |
| Leaving it idle up to 8 hours | session kept (token TTL) |

**Do not press reload during the demo.** There is no refresh-token flow, so a
reload drops you at the login screen and you will have to sign in again. Move
between screens using the sidebar, never the browser's reload or address bar.

A token issued at login lasts 8 hours, so a session that is never reloaded will
outlast any demo.

---

## Shutting down

```bash
# Ctrl-C in terminals 1 and 2, then confirm the ports actually released:
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

Both silent means a clean stop. If either still shows a process, it detached —
`kill <pid>`.
