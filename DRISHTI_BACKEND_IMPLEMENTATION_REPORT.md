# Drishti Backend — Implementation Report

| | |
|---|---|
| Date | 2026-09-22 |
| Branch | `feat/drishti-platform-foundation` — **5 commits, not merged** |
| Base | `main` @ `53d5456` |
| Endpoints | 22 → **86** |
| Models | 12 → **22** |
| Tests | 246 → **361**, all passing |
| Build / typecheck / lint | all pass |

**The branch is not merged and was not pushed.** Merging is your call, per the
instruction not to self-merge.

---

## Contents

1. [Current architecture](#1-current-architecture)
2. [Schema changes](#2-schema-changes)
3. [New models](#3-new-models)
4. [New endpoints](#4-new-endpoints)
5. [Authentication changes](#5-authentication-changes)
6. [Authorization changes](#6-authorization-changes)
7. [Risk engine changes](#7-risk-engine-changes)
8. [Audit system](#8-audit-system)
9. [Remediation](#9-remediation)
10. [Search](#10-search)
11. [Pagination](#11-pagination)
12. [Docker](#12-docker)
13. [Deployment](#13-deployment)
14. [Tests](#14-tests)
15. [Demo data](#15-demo-data)
16. [Frontend API contracts](#16-frontend-api-contracts)
17. [Remaining blockers](#17-remaining-blockers)
18. [Verdict](#backend-ready-for-frontend)

---

## 1. Current architecture

Unchanged in shape, deliberately. Node 20+ / Express 5.2 / TypeScript 5.9
strict / Prisma 7.10 with the `pg` driver adapter / PostgreSQL. ESM. The
existing layering was sound and was extended, not replaced:

```
routes/       HTTP, Zod validation, RBAC gates, audit calls
services/     business logic — every function takes a TenantContext first
lib/          prisma client, tenant scope, pagination, http envelopes, errors
middleware/   auth, validate, security, errorHandler
```

There is still no controller layer and no repository layer. Adding either would
have been churn: route handlers are thin, and services already own the Prisma
calls. The one structural addition is `src/lib/tenant.ts`.

The codebase's existing idiom — pure logic split from database logic so it
unit-tests without Postgres (`riskScoring` / `riskEngine`, `flowStatus` /
`dataFlowService`, `importParsing` / `importService`) — was preserved.

**New files:** `lib/tenant.ts`, `lib/pagination.ts`, `lib/http.ts`,
`services/{auditService,auditQueryService,controlService,policyService,remediationService,identityService,searchService,reportService}.ts`,
`routes/{organization,identities,controls,policies,remediations,audit,search,reports}.ts`.

---

## 2. Schema changes

One migration: `20260922103000_drishti_platform_foundation`, 369 lines,
hand-authored.

**Why hand-authored.** `prisma migrate dev` is interactive and refuses to run
non-interactively; more importantly it emits
`ADD COLUMN "organizationId" INTEGER NOT NULL` with no default, which **cannot
execute against a table that already has rows** — and nine tables did. Each
tenant column is therefore added nullable, backfilled to the founding
organisation, then made `NOT NULL`. Nothing is dropped; no row is deleted.

**How it was verified before touching anything real.** A `pg_dump` of the
populated development database was restored into a throwaway probe database,
the migration applied there inside a single transaction, every row count
confirmed unchanged, zero rows confirmed unscoped, and
`prisma migrate diff` confirmed the probe schema matched the target exactly.
Only then was `migrate deploy` run against development. The probe was dropped.

This is the gap `POST_DEMO_BACKLOG.md` item 12 records — that CI never tests a
migration against a populated database. It was tested here.

**Existing data survived intact:** 16 assets, 5 vendors, 10 flows, 8 risks, 6
identities, 9 grants, 5 threats, 3 users, all re-parented to organisation 1
("Meridian Health System").

### Constraints the application assumed but the database did not enforce

Now real, and all verified satisfiable against live data before being applied:

| Constraint | What it fixes |
|---|---|
| `Risk @@unique([assetId])` | One assessment per asset. Movement lives in `RiskHistory`, not extra rows. |
| `VendorRisk @@unique([vendorId])` | Same for vendors. |
| `DataFlow @@unique([sourceAssetId, targetAssetId, phiTypeId])` | The natural key the importer checked in application code only. |
| `Identity @@unique([organizationId, displayName])` | Made the importer's "ambiguous identity" case unrepresentable. |
| `Asset/Vendor/PHIType/Control/Policy @@unique([organizationId, name])` | Names unique **per tenant**, not globally. |

Also added: `updatedAt` on every mutable model, `archivedAt` on the five
archivable ones, `revokedAt`/`lastReviewedAt` on access grants.

---

## 3. New models

Ten, taking the schema from 12 to 22.

| Model | Purpose | Tenant scoped |
|---|---|---|
| `Organization` | The tenant boundary | — |
| `OrganizationMember` | User ↔ org with a per-org role | via org |
| `RefreshToken` | Rotating sessions, stored hashed | via user |
| `RiskHistory` | Score movement with reason and actor | ✅ |
| `Control` | Safeguards — the missing half of the risk model | ✅ |
| `AssetControl` | Which controls protect which asset | inherited |
| `Policy` | Written policy register | ✅ |
| `PolicyControl` | Policy ↔ control | inherited |
| `Remediation` | Findings and the work to close them | ✅ |
| `AuditEvent` | Append-only record of who did what | ✅ |

Every customer-owned table carries `organizationId` **directly**, even where it
could be derived through a parent. The denormalisation is deliberate: it makes
the tenant filter one indexed predicate on every query rather than a join, so a
missing scope reads as a visible omission instead of a subtle one. The two pure
join tables (`AssetPHI`, `VendorAssetAccess`) inherit scope from parents that
are already scoped.

Nine new enums, including `AuditAction` (43 values) and `RiskChangeReason`.

---

## 4. New endpoints

**22 → 86.** Full detail in `API_REFERENCE.md`; the handoff summary is in
`FRONTEND_API_CONTRACT.md`.

| Area | Before | After | Added |
|---|---|---|---|
| Auth | 3 | 5 | refresh, logout-all |
| Organization | 0 | 2 | org, members |
| Assets | 4 | 13 | archive, restore, assessment, recompute, risk-history, history, control-evidence, control link/unlink |
| Risks | 2 | 4 | distribution, history (recompute became an alias) |
| Data flows | 1 | 2 | detail |
| Vendors | 5 | 11 | assessment, archive, restore, asset link/unlink, history |
| Identities | 0 | 5 | full CRUD + archive |
| Access | 1 | 7 | summary, detail, grant, update, revoke, review |
| Threats | 1 | 7 | summary, detail, create, update, status, history |
| Controls | 0 | 7 | full CRUD + archive + asset link/unlink |
| Policies | 0 | 7 | full CRUD + archive + control link/unlink |
| Remediation | 0 | 8 | full CRUD + status + assign + summary + history |
| Audit | 0 | 1 | trail (ADMIN) |
| Search | 0 | 1 | global |
| Reports | 0 | 1 | risk assessment |
| Import | 4 | 4 | unchanged (scoped + audited) |
| Health | 1 | 1 | unchanged |

### Deletion policy

**No DELETE on any customer record**, and that is a decision, not an omission.
Assets, vendors, identities, controls and policies **archive**; access grants
**revoke**. The compliance record is the product: an asset that held PHI stays
part of it after decommissioning, and its threats, grants and risk history are
evidence an auditor asks for. Cascading them away on a DELETE would destroy
exactly that.

The only `DELETE` verbs in the API remove **links** (`/assets/:id/controls/:id`,
`/vendors/:id/assets/:id`, `/policies/:id/controls/:id`), which is correct — a
link is not a record of anything having happened.

---

## 5. Authentication changes

| | Before | After |
|---|---|---|
| Access token | 8 h, unrevocable | **1 h** |
| Refresh token | none | **30 d, rotating, revocable** |
| Refresh storage | — | SHA-256 digest only |
| Revocation | none | per-token, and `logout-all` |
| Cookie | `medguard_token` | `drishti_token` + `drishti_refresh` |
| `secure` flag | never set | set when `NODE_ENV=production` |
| `sameSite` | always `lax` | `none` in production |

**Reuse detection.** Presenting an already-rotated refresh token revokes
**every** live session for that user. Rejecting only the replayed token would
leave the thief's rotated copy working.

**Membership is re-checked on every refresh**, so access withdrawn mid-session
takes effect at the next refresh rather than at the next login.

Why the access token got shorter: an 8-hour bearer token that cannot be revoked
is 8 hours of exposure after a leak. The long-lived half of the session is now
the half the server can actually kill.

The security model was not weakened anywhere: bcrypt cost unchanged,
user-enumeration resistance unchanged, `JWT_SECRET` still refuses to default,
rate limits unchanged. The JSON body limit briefly went to 1 MB during
development and was put back to the 100 KB default — imports are multipart and
bounded separately, so a larger ceiling widened the DoS surface for nothing.

**Not implemented:** signup, password reset, MFA on API login, org-switch
endpoint.

---

## 6. Authorization changes

Roles are unchanged (`ADMIN`/`ANALYST`/`VIEWER`, flat, no hierarchy) but are now
**per-organisation**, read from `OrganizationMember` rather than the account's
global default. The same account can be ADMIN in one tenant and VIEWER in
another.

A third tier was added: **archive and restore are ADMIN-only**, sitting between
ordinary writes (ADMIN/ANALYST) and import (ADMIN). Audit reads are ADMIN-only.

### Tenant isolation

`TenantContext` is built in `requireAuth` from the signed token and passed as
the first argument to every service function. `scope(ctx)` is spread into every
query over a scoped model. Single-record reads use `findFirst` with the scope,
never `findUnique` by id — `findUnique` cannot express the extra predicate and
would return another tenant's row perfectly happily.

**No endpoint reads an organisation id from a path, query or body.** Sending one
has no effect.

Cross-tenant access returns **404, not 403**: "that exists but is not yours"
confirms the id is real somewhere, which is itself a small leak.

Write paths verify foreign keys too. Attaching a remediation to another
tenant's asset id would otherwise read that asset's name back out of your own
detail response — a cross-tenant read through a write. 22 tests cover this.

**Still absent:** resource-level ownership (an ANALYST can edit any record in
their organisation), and department scoping. Both need a product answer first —
this is `POST_DEMO_BACKLOG.md` item 7, still open.

---

## 7. Risk engine changes

**The formula is untouched:** `score = (l × i × e × c) / 625 × 100`, two
decimal places, five bands at 20/40/60/80. Inputs still validate as integers
1–5.

What changed:

| | Before | After |
|---|---|---|
| Rows per asset | many, latest wins | **one**, DB-enforced |
| History | none — overwritten in place | **`RiskHistory`** |
| Create an assessment | CSV import only | **`POST /api/assets/:id/assessment`** |
| Recompute | in-place update | upsert + history entry |
| Reason for a change | not recorded | `RiskChangeReason` enum + actor |

Two gaps the audit found are closed. Recompute could not change a score
(it re-read the same stored inputs) and destroyed history; there was no API to
record an assessment at all, so an assessor using the product could not do the
one thing the product is for.

A recompute that changes nothing writes **no** history row — recording it would
bury real changes under rows saying "still 8.64".

### Controls and the risk model

`controlGap` has always been an assessor's number. `Control` is what it should
be argued from, and `GET /api/assets/:id/control-evidence` returns a
`suggestedControlGap` from a stated weighted formula.

It is **never applied automatically**, and the response says
`"applied": false` literally. A score that moved because someone ticked a
checkbox is not one anybody could defend in an audit. The assessor accepts it
by posting an assessment, which is recorded with an actor.

**Not implemented:** vendor risk history (`RiskHistory` is keyed to an asset),
and automatic recomputation when related data changes — nothing triggers a
rescore when a control, grant or vendor moves.

---

## 8. Audit system

`AuditEvent` — append-only by convention, with `auditService.ts` as the only
writer. Nothing in the codebase updates or deletes a row, and the API exposes no
write path.

**43 action types** covering authentication (including `LOGIN_FAILED`), every
CRUD path, risk changes, threat and remediation transitions, access grants and
revocations, and imports (`STARTED`/`COMPLETED`/`FAILED`).

Recorded per event: actor (id + denormalised email so the trail survives user
deletion), organisation, action, entity type and id, result, metadata, IP, user
agent, timestamp. Updates carry `metadata.changes = { field: { from, to } }`.

**Two properties that matter:**

1. **Atomicity.** A data mutation passes its transaction client to
   `recordAudit`, so the change and its record commit or roll back together.
   There is no state where the write happened and the record of it did not. The
   one exception is `LOGIN_FAILED`, recorded best-effort because failing an
   already-failing request twice helps nobody — and that is commented at the
   call site.
2. **No secrets or PHI.** `sanitiseMetadata` strips keys matching a denylist
   (password, token, secret, apikey, credential, ssn, dob, mrn, patient…),
   truncates long strings, and bounds recursion depth. It is a backstop, not
   permission to be careless at call sites. Tested directly.

The audit gap was the largest finding in `CURRENT_BACKEND_STATE.md`, and it
demonstrated itself: that report could prove eight assets were bulk-imported
into the demo database on 2026-09-22 but **could not determine who did it**.
That is now recorded.

---

## 9. Remediation

`Remediation` links a finding to the work that closes it. Six severity/status
combinations are seeded to exercise every state.

Statuses: `OPEN`, `IN_PROGRESS`, `RESOLVED`, `ACCEPTED`, `REOPENED`, with a
transition table enforced server-side; illegal moves return 409 naming the
legal ones, and the detail response carries `allowedTransitions[]`.

`ACCEPTED` — risk accepted without fixing — stays distinct from `RESOLVED` in
every count, because in a compliance report those are different outcomes.

Optional links to asset, vendor, threat, control, identity or access grant, all
`SetNull` on delete: the finding that an asset was unencrypted remains true and
worth keeping even after the asset record goes. Every link, and the owner, is
verified to belong to the caller's organisation before it is stored.

### On the frontend's fabricated message

This subsystem replaces *"Violation resolved, encryption applied."*

Resolving a remediation persists a status, a timestamp, an actor and an audit
event. It **does not** touch the asset, control or threat the finding points
at, and there is a test asserting that the asset's `encrypted` flag and
`updatedAt` are unchanged after a resolve.

Marking work done is a claim about people. It is not the same as the estate
having changed, and conflating them would put an assertion in the compliance
record that nobody performed. If the UI needs to say encryption was applied,
something has to apply it — `PATCH /api/assets/:id`.

---

## 10. Search

`GET /api/search?q=&types=&limit=` across assets, vendors, identities, threats,
remediations, controls and policies. Returns `{ type, id, title, status,
context }` per hit.

Bounded by construction: 2-character minimum, 10 results per type, 50 overall,
archived records excluded, and every query carries the tenant scope. There is
deliberately no "search everything" mode — an unbounded cross-table scan is a
denial-of-service primitive handed to any authenticated user.

---

## 11. Pagination

Offset pagination on every scalable list: `?page=` (default 1), `?pageSize=`
(default 25, max 200, **capped rather than rejected**). Response carries
`meta: { page, pageSize, total, totalPages }`; `totalPages` is never below 1.

Offset rather than cursor because the tables are page-numbered and need a total
count to render "page 3 of 12", which a cursor cannot give.

Two endpoints derive their filter in JavaScript (`/api/access?flaggedOnly`,
`/api/dataflows?status`) because the predicate is computed, not stored. Those
run unpaginated and take the page from the filtered set, so `meta.total` stays
truthful. Documented at the call site.

**This is the one silent change for existing clients:** code that reads `data`
and ignores `meta` still works but now sees 25 rows where it used to see
everything.

Summaries moved to their own endpoints (`/api/access/summary`,
`/api/threats/summary`, `/api/remediations/summary`, `/api/risks/distribution`)
and count in SQL over the whole estate — a summary computed alongside a page
would silently describe the page.

---

## 12. Docker

Multi-stage `Dockerfile`: the build stage keeps TypeScript and the Prisma CLI,
the runtime stage keeps neither. Runs as the unprivileged `node` user, with a
healthcheck against `/health`.

Two build traps, both commented where they are handled: npm 11 blocks install
scripts by default (so a plain `npm ci` silently fetches neither the Prisma
engine nor esbuild), and `prisma.config.ts` resolves `DATABASE_URL` at module
load even though `prisma generate` never connects — a placeholder scoped to the
build layer satisfies it, and nothing real is baked into image history.

`docker-compose.yml` runs Postgres + API, with the API waiting on a Postgres
healthcheck that names the user and database (bare `pg_isready` reports ready
before the database exists). Secrets come from the environment and the compose
file **fails fast** rather than defaulting them.

**Migrations do not run on container start.** A container that migrates as it
boots races every other replica during a rolling deploy, so `migrate deploy` is
a separate compose service behind the `tools` profile.

**Verified, not assumed:** the image builds, starts against a real Postgres,
answers `/health`, serves an authenticated login plus the organization, assets,
controls, remediation, report and search endpoints with real seeded data, and
Docker reports the container `healthy`. The probe container, image and scratch
database were removed afterwards.

---

## 13. Deployment

`DEPLOYMENT.md` documents four environments (development / test / demo /
production), the release order (migrate as a job → deploy → verify), required
environment variables, and the cross-domain cookie trap — with
`NODE_ENV=production` the cookies are `Secure; SameSite=None`, which requires
HTTPS on both sides and fails **silently** otherwise.

It states plainly that `npm run db:seed` truncates every table, and that the
test database is guarded twice (vitest overrides `DATABASE_URL`; `globalSetup`
refuses any database whose name lacks "test").

| Check | Result |
|---|---|
| `npm run build` | **PASS** — 78 files emitted |
| `npm run typecheck` (src + tests) | **PASS** |
| `npm run lint` | **PASS** |
| `npm test` | **PASS** — 361/361 |
| `docker build` | **PASS** |
| Container health + authenticated API | **PASS** |

Not verified and not claimed: a real staging or production deploy, TLS
termination, horizontal scaling, backup/restore. No such environment was
available.

---

## 14. Tests

**246 → 361.** 16 files. Zero skipped.

| File | Tests | Covers |
|---|---|---|
| `tenancy.test.ts` | **22** | cross-tenant isolation, reads and writes |
| `lifecycle.test.ts` | **32** | assessment, risk history, threat triage, controls, remediation, archive |
| `discovery.test.ts` | **25** | pagination, filtering, sorting, search, reports |
| `audit.test.ts` | **21** | audit events, sanitisation, diffing |
| `session.test.ts` | **15** | refresh rotation, reuse detection, revocation |
| existing 11 files | 246 | auth, RBAC, routes, vendors, access, threats, import, security, unit |

The tenancy fixture seeds **two** organisations, the second holding its own
asset, vendor, identity and threat plus a user who belongs only to it. Every
isolation assertion runs against rows that actually exist — a missing scope
returns the other tenant's data and the test fails. A single-tenant fixture
could only assert absence, which passes just as well when the query is broken.

Unit tests remain database-free and separable; integration tests run only
against `TEST_DATABASE_URL`.

### Two things the tests caught

- A comment in `routes/risks.ts` claimed the old
  `POST /api/risks/:assetId/recompute` was kept as an alias. It was not. The
  alias is now real, tested, and documented as deprecated.
- A new `NEVER_REVIEWED` access flag was **removed rather than accommodated**.
  It fired on every row of a fresh estate, and `riskFlagCount` is what the
  review list sorts by, so a universal flag would have drowned the four that
  mean something. `lastReviewedAt` is still returned per row and counted in the
  summary.

---

## 15. Demo data

`prisma/seed.ts` extended and verified against a scratch database (**never run
against development — it truncates**):

| Entity | Count | Notes |
|---|---|---|
| Organization | 1 | Meridian Health System |
| Assets / PHI types / flows | 8 / 4 / 10 | unchanged |
| Risks | 8 | spanning all five bands |
| Vendors | 5 | mixed BAA states |
| Identities / grants | 6 / 9 | includes service accounts and a departed contractor |
| Threats | 5 | across all four statuses |
| **Controls** | **8** | 2 effective, 2 partial, 2 ineffective, 1 planned, 1 not implemented |
| **Policies** | **4** | ACTIVE / UNDER_REVIEW / DRAFT, one review overdue |
| **Remediations** | **6** | 3 OPEN, 1 IN_PROGRESS, 1 RESOLVED, 1 ACCEPTED |
| **Risk history** | **8** | one `INITIAL_ASSESSMENT` per assessment |

Findings link to the records that raised them — the unencrypted billing
database, the vendor with no BAA, the contractor's stale ADMIN access, the Tor
session on the claims gateway. All synthetic.

> ### ⚠ The demo database does not have this data yet
>
> `medguard_dev` currently holds the migrated original data — 16 assets, 0
> controls, 0 policies, 0 remediations. **I did not reseed it**, because
> `db:seed` truncates and the instruction was not to blindly reseed.
>
> To load the full demo story: `npm run db:seed`. This **destroys** current
> contents, including the 8 assets someone bulk-imported on 2026-09-22 (ids
> 9–16, which have no PHI links, flows or risk scores — see
> `CURRENT_BACKEND_STATE.md`). Your call.
>
> Everything works against the current data; controls, policies and
> remediation simply return empty lists until it is seeded.

---

## 16. Frontend API contracts

`FRONTEND_API_CONTRACT.md` is the handoff document. It leads with **four
breaking changes**:

1. `/api/access` and `/api/threats` return paginated arrays; summaries moved to
   `/summary`.
2. Access tokens last 1 hour, not 8 — cookie clients need no change; in-memory
   clients should refresh on 401 and retry once.
3. Cookie renamed to `drishti_token` (the old name is still accepted inbound).
4. CSV templates download as `drishti-<entity>-template.csv`.

Plus the silent one: every list is paginated now.

It also maps all seventeen steps of the customer demonstration to live
endpoints, and closes with what is deliberately absent so nobody builds UI
against something that will never exist.

`API_REFERENCE.md` is the per-endpoint detail for all 86. Read examples in it
were executed against the running server with responses pasted verbatim; write
examples were **not** run live (that would mutate the demo database) and are
covered by the test suite instead. That distinction is stated in the document.

---

## 17. Remaining blockers

### For the frontend — none

Every endpoint the demonstration needs exists, is tested, and returns real
persisted data. Nothing is stubbed and nothing returns fabricated values.

### Backend gaps, honestly listed

| Gap | Severity | Note |
|---|---|---|
| **Demo database not seeded** | operational | One command, but destructive. Your decision. |
| **Vendor risk history** | P1 | `RiskHistory` is keyed to an asset. Vendors have current risk but no trend. Do not build a vendor trend chart. |
| **No automatic risk recomputation** | P1 | Nothing rescores when a control, grant or vendor changes. Deliberate for now — automatic scoring is exactly what must not happen without an assessor. |
| **No resource-level authorization** | P1 | An ANALYST can edit any record in their organisation. Needs a product answer (backlog item 7). |
| **Org switching** | P2 | `memberships` is returned; there is no switch endpoint. Only one org exists in demo data. |
| **Notifications** | P2 | Not built. Derivable from existing filters. |
| **No CSV/PDF export** | P2 | Reports are JSON only. |
| **`access?flaggedOnly` and `dataflows?status` filter in JS** | P2 | Derived predicates. Fine at current scale; would need materialising at 10k+ grants. |
| **`samples/…sample_100.csv` still unusable** | P2 | 19 of 20 `type` values violate the `AssetType` enum. **I did not widen the enum** — that is a product taxonomy decision, not a fix. |
| **No `npm audit` in CI** | P2 | |
| **Database/package/remote still named MedGuard** | P3 | Deliberate. No schema change waits on it. |
| **No OpenAPI spec** | P3 | Markdown only. |

### Not done, and deliberately

- **No AI endpoints.** None exist; none return canned text.
- **No compliance score.** Coverage ratios only, with a disclaimer in the
  payload.
- **No DELETE.** Archive and revoke instead.
- **No fabricated data paths.** Every number is counted from persisted rows.

---

# BACKEND READY FOR FRONTEND

## **YES**

All 86 endpoints are implemented, tested against a real database, and serving
real persisted data. Build, typecheck, lint and 361 tests pass. The container
builds and runs.

### Frontend dependencies — what you must handle

**Required (breaking):**

1. `/api/access` and `/api/threats` — read `data` as an array; call `/summary`
   for the counts.
2. Every list is paginated at 25 by default — pass `pageSize` or handle pages,
   or you will silently show a truncated estate.
3. Cookie name is `drishti_token` if you read it.
4. Access tokens expire hourly — cookie clients are fine; in-memory clients
   need a refresh-on-401 retry.

**Required (operational):**

5. Decide whether to run `npm run db:seed`. Controls, policies and remediation
   return empty lists until you do. It truncates.

**Do not build:** vendor risk trend charts, compliance-score gauges, delete
buttons, notification feeds, or an org switcher. The first has no data, the
second will never exist, the third is archive/revoke, and the last two are not
implemented.

### Two things to carry into the demo

- **Resolving a remediation does not change the asset.** That is the correct
  behaviour and the point of the subsystem. If the story needs the estate to
  change, change it — `PATCH /api/assets/:id`.
- **Risk changes need an assessment.** Recompute cannot move a score on its own;
  `POST /api/assets/:id/assessment` is what produces the "65 → 72" moment, and
  the movement then appears in `/risk-history` with a reason and an actor.

---

*Branch `feat/drishti-platform-foundation`, 5 commits, not merged and not
pushed. `main` is untouched. No database was reset, reseeded or truncated; the
development database holds exactly the rows it held before, plus the tenancy
columns.*
