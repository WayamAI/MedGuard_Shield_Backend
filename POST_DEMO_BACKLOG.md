# Post-Demo Backlog

Known gaps recorded at the end of the demo build. **Nothing here blocks the demo** —
it is all deliberately deferred, and captured so it is not rediscovered the hard way.

Ordered roughly by when it becomes urgent.

---

## 1. No automated integration tests through Express

Every route was verified by hand — curl and in-browser fetches, repeatedly — but the
12 automated tests are unit tests over the pure functions only (`riskScoring`,
`flowStatus`). Nothing exercises a request through the Express stack: no middleware,
no validation, no error mapping, no Prisma.

**Why it matters:** a service edit can break a route with every test still green. In
practice this means route changes are not safe to make unsupervised — each one needs
a manual curl pass to confirm it still works.

**What it needs:** supertest against `createApp()`, over a test database, covering at
minimum the happy path plus 401 / 400 / 404 for each route. The app is already shaped
for it — `createApp()` is exported separately from `server.ts` precisely so a test can
mount it without binding a port.

**Do it before:** any further route work.

---

## 2. `requireRole` is implemented but unused

`requireRole(["ADMIN", "ANALYST"])` exists in `src/middleware/auth.ts`, is typed
against the `Role` enum, and works — but no route calls it. Every current endpoint is
a read that any signed-in role may perform, so gating them would add ceremony without
adding protection.

**When to wire it up:** the first write endpoint — asset create/update, vendor
create/update, or editing risk inputs. Those are the operations where VIEWER must be
refused. Mount it after `requireAuth`, which populates `req.user`.

**Not before then.** Applying it to the current read endpoints would be
security theatre.

---

## 3. No rate limiting or security headers

Not present: `helmet` (or equivalent security headers), rate limiting generally, and
login-attempt throttling specifically. `POST /api/auth/login` will accept unlimited
attempts as fast as they arrive.

Explicitly out of scope for a local demo, where the only client is a laptop on the
same machine.

**Required before any real sale or public deployment** — login throttling most
urgently, since bcrypt comparison is the one deliberately expensive operation in the
system and therefore the cheapest thing for an attacker to abuse.

---

## 4. `SameSite=Lax` cookie will break on separate domains

The session cookie is `httpOnly; SameSite=Lax; Max-Age=28800`. That works today only
because `localhost:8080` and `localhost:4000` are the **same site** — ports are not
part of same-site computation, only scheme plus registrable domain.

**The moment the API and frontend sit on different domains** (`api.example.com` vs
`app.example.com`), the browser stops sending that cookie. It needs
`SameSite=None; Secure`, which in turn requires HTTPS on both.

**Why this one is nasty:** it fails *silently*. No CORS error, no console warning —
requests simply arrive unauthenticated and every call returns 401, as though the user
were logged out. Easy to misdiagnose as an auth bug when it is a cookie-attribute bug.

Changing it now would be wrong: `SameSite=None` requires `Secure`, and `Secure`
cookies are not set over plain http, so it would break the working local setup. This
is a deploy-time change, made together with HTTPS.

Relevant code: the `res.cookie` options in `src/routes/auth.ts`.

---

## 5. `prisma migrate reset --force` has never actually been run

`DEMO_RUNBOOK.md` documents it as the last-resort full reset. It has **not** been
executed — Prisma's CLI refuses that command on an agent's say-so and requires
explicit human confirmation, which is correct behaviour for something that drops a
database.

So it is documented but unverified.

**Action:** run it manually once, ideally before Monday, purely to confirm it behaves
as the runbook claims:

```bash
cd "/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend"
grep DATABASE_URL .env          # confirm the target is medguard_dev, not anything else
npx prisma migrate reset --force
```

Then re-run the step 4 verification block in the runbook. Expect 8 assets, 10 flows,
8 risks, 3 users, and asset ids 1–8.

Likely never needed live — `npx prisma db seed` handles every realistic "data looks
wrong" situation and is exercised constantly. But if a full reset *is* ever needed
mid-demo, that is the worst possible moment to discover the command does not do what
the runbook says.

---

## Not gaps — deliberate decisions, recorded so they are not "fixed" by mistake

- **Local JWT auth instead of Supabase/Clerk.** B6 named those providers; neither
  could be provisioned without an account and API keys. The seam is one function:
  `requireAuth` depends only on `verifyToken(token) → AuthUser`. Swapping providers
  means reimplementing that and deleting the login route — no route handler changes.
- **No refresh-token flow.** Sessions last 8 hours and survive page reloads via the
  persistent cookie; after that, re-login. The frontend is built against this.
- **The steep risk curve.** `score = l × i × e × c / 625 × 100` is the spec'd formula.
  It skews low by nature — `4/4/4/3` scores 30.72, and EXTREME effectively requires
  all 5s. Seed inputs are chosen to span all five bands regardless. Thresholds live in
  `src/services/riskScoring.ts` if the curve is ever revisited.
- **`flowStatus` reads `mfaEnabled` from the target asset.** A flow has no MFA setting
  of its own; the target is the system the records land in.
