# Post-Demo Backlog

> **All of the expansion work is merged into `main`** as of 2026-09-15, at
> `575488f`. Items 1, 2, 3, 13 and 14 are closed — integration tests, RBAC on
> writes, rate limiting plus security headers, live CI, and the risk-recompute
> role gate. They are kept below for the reasoning.
>
> Still open: **4, 5, 6, 7, 8, 9, 10, 11, 12 and 15.**

Known gaps recorded at the end of the demo build. **Nothing here blocks the demo** —
it is all deliberately deferred, and captured so it is not rediscovered the hard way.

Ordered roughly by when it becomes urgent.

---

## 1. ~~No automated integration tests through Express~~ — CLOSED

Closed in `6587708`, which added supertest against `createApp()` over a real
test database, exactly as prescribed below. The suite has grown with each
module since: **113 tests across 9 files**, of which 101 are integration tests
through the full Express stack. `tests/setup/globalSetup.ts` refuses to run
against a database whose name lacks "test", because the fixtures truncate
every table.

The original note is kept below for the reasoning.

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

## 2. ~~`requireRole` is implemented but unused~~ — CLOSED

Closed across three commits, in the order this note predicted: `ec724af`
(asset create/update), `f1b0267` (vendor create/update/recompute), and
`ec09811` (risk recompute — the one that was missed first time round, see
item 14). Every write path is now gated; reads stay open to any signed-in
role, as argued below.

The original note is kept below for the reasoning.

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

## 3. ~~No rate limiting or security headers~~ — CLOSED

Closed in `1fa580a`: `helmet` on every response including errors and 429s,
plus two tiers of rate limiting in `src/middleware/security.ts` — a global
300 per 15 min, and 10 per 15 min on `POST /api/auth/login` counting failures
only, so a legitimate user signing in repeatedly is never locked out.

The login throttling this note called most urgent is therefore in place. The
limiters are factories rather than module-level singletons, so each app built
in a process gets its own budget. Covered by `tests/integration/security.test.ts`.

The original note is kept below for the reasoning.

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

Coverage is at least uniform now: every write path is gated the same way,
including `POST /api/risks/:assetId/recompute`, which was the one that had
been missed (item 14). The remaining gap is depth, not consistency.

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
is live and enforcing typecheck, lint and the full suite. First green run:
34699885907; first green run on `main` itself: 34924544457.

The follow-up it left behind is also closed: `actions/checkout` and
`actions/setup-node` were bumped v4 → v5 in `e0850b3`, clearing GitHub's
deprecated-Node-20 warning.

Triggers were narrowed to `main` alone in `575488f`, once the expansion branch
had merged. See item 15 for what that costs.

## 14. ~~`POST /api/risks/:assetId/recompute` was an ungated write~~ — CLOSED

Found during a full read of the codebase on 2026-09-15, not by a failing test —
nothing had asserted the rule, so nothing broke when it was absent.

The endpoint persists a new `score`, `band` and `computedAt` via
`recomputeAssetRisk`, which makes it a write, but it sat behind `requireAuth`
only. Any signed-in `VIEWER` could rescore any asset. Its exact twin,
`POST /api/vendors/:id/recompute`, had been gated correctly all along — so this
was an inconsistency, not a policy decision.

Closed in `ec09811`: `requireRole(["ADMIN", "ANALYST"])` mounted ahead of
`validate`, matching the ordering in `routes/vendors.ts`, plus five cases in
`tests/integration/rbac.test.ts` covering ADMIN, ANALYST, VIEWER 403, anonymous
401, and that a refused VIEWER leaves `computedAt` untouched.

**The lesson worth keeping:** item 2 predicted the gate would be needed at "the
first write endpoint" and listed "editing risk inputs" among them. Recompute is
exactly that, and it still slipped through — because it was written as a route
that *reads stored inputs*, which made it feel like a read. Any endpoint that
ends in a `prisma.*.update` is a write regardless of where its inputs came from.

## 15. `post-demo/expansion` is merged but has no CI coverage

The remote branch is deliberately kept at `10a9cca` for reference, but
`575488f` narrowed the workflow triggers to `main`, so a push to it now runs
no checks at all.

That is the right trade while it is dormant. **If the branch is ever revived,
add it back to both the `push` and `pull_request` branch lists before pushing
to it** — otherwise work lands there entirely unverified, which is worse than
the stale trigger name that prompted the change.
