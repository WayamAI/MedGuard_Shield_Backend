# Post-Demo Backlog

> **Items 1, 2 and 3 are now closed** on `post-demo/expansion`: integration
> tests, RBAC on writes, and rate limiting plus security headers all shipped.
> They are kept below for the reasoning. Items 4 and 5 stand, and the new
> deferrals are recorded at the end.

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

Then re-run the step 4 verification block in the runbook. Its check 6 asserts 8
assets, 10 flows and 8 risks. The 3 user rows and the 1-8 asset id range are not
asserted there — neither is exposed through the API — so confirm those with the
two `psql` queries the runbook gives alongside its expected output.

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

---

# Deferred during the expansion phases

Recorded rather than silently skipped.

## 6. No pagination on any list endpoint

`/api/assets`, `/api/vendors`, `/api/access` and `/api/threats` all return
every row. Fine at demo scale — the largest is 9 rows — and wrong the moment a
real estate has thousands of access grants, which is the endpoint that will hurt
first.

Needs cursor pagination plus a bounded default page size. The response envelope
is already `{ data: ... }`, so a `meta` sibling can carry the cursor without
breaking existing clients. `/api/access` should go first.

## 7. RBAC is coarse: two tiers, no ownership

`requireRole(["ADMIN", "ANALYST"])` gates every write identically, so an ANALYST
can edit any asset or vendor in the estate. There is no notion of owning a
record, no department scoping, and ADMIN and ANALYST are indistinguishable in
what they may touch.

Granular RBAC means deciding what ANALYST may *not* do — probably deleting, and
probably editing records outside their department. That needs a product answer
before it needs code.

## 8. No delete anywhere

Create and update only. Deletion raises questions the demo did not need: soft
versus hard, what happens to a risk history when its asset goes, whether a
vendor with live access can be removed at all. Cascades are already declared in
the schema, so hard delete would work — that is exactly why it should not be
added without deciding the policy first.

## 9. Access grant `lastUsedAt` is seeded, never written

Nothing updates it. Staleness detection is therefore only as good as whatever
populates that column, and right now that is the seed script. A real deployment
needs it fed from access logs; until then treat `/api/access` flags as a
demonstration of the rule, not a live finding.

## 10. Threats are read-only

`GET /api/threats` only. No transition endpoint, so nothing can move a threat
from OPEN to INVESTIGATING to RESOLVED through the API. Status changes are
seed-time only. A write path needs an audit trail — who changed it, when, and
why — which is a bigger piece than the read model.

## 11. Vendor risk inputs cannot be edited

`POST /api/vendors/:id/recompute` rescores from stored inputs, but no endpoint
sets the four 1-5 values. Same gap exists for asset risk. The inputs are
assessor judgement, so the write path probably wants a justification field and
an audit record rather than a bare PATCH.

## 12. CI does not run migrations against a clean database

The workflow runs `prisma migrate deploy` through `globalSetup` on a fresh
service container each run, which does exercise the migration chain. It does not
test a migration against an *existing* populated database, so a migration that
works on empty Postgres but fails on real data would pass CI.

## 13. ~~The CI workflow is parked, not active~~ — CLOSED

Closed once the `workflow` OAuth scope was granted. `.github/workflows/ci.yml`
is live and enforcing typecheck, lint and the full suite on push and PR to
`main` and `post-demo/expansion`. First green run: 34699885907.

One follow-up left behind it: GitHub now warns that `actions/checkout@v4` and
`actions/setup-node@v4` target Node.js 20, which is deprecated on runners and
being forced onto Node 24. Harmless today, worth bumping to v5 when convenient.
