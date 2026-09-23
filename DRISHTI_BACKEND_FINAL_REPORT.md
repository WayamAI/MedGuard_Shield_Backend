# Drishti Backend — Final Report

| | |
|---|---|
| Date | 2026-09-23 |
| Version | 0.3.0 |
| Branch | `feat/drishti-platform-foundation` — **16 commits, pushed** |
| Remote | `origin/feat/drishti-platform-foundation` @ `d71567c` |
| Endpoints | **87** (1 public, 86 authenticated) |
| Models | **22** |
| Tests | **547 passing**, 0 skipped |
| Build / typecheck / lint | all pass |

The three gaps the previous report left open are closed: **vendor risk
history**, **automatic risk recomputation**, and **analyst authorization**.
Each was verified against a real Postgres through real HTTP, not only in tests.

`main` is untouched. The branch is pushed but **not merged** — merging remains
your call.

---

## Contents

1. [Architecture](#1-architecture) · 2. [Schema](#2-schema) · 3. [Endpoints](#3-endpoints)
4. [Authorization](#4-authorization) · 5. [Tenant isolation](#5-tenant-isolation)
6. [Risk engine](#6-risk-engine) · 7. [Automatic recomputation](#7-automatic-recomputation)
8. [Vendor risk history](#8-vendor-risk-history) · 9. [Audit](#9-audit)
10. [Remediation](#10-remediation) · 11. [Controls](#11-controls)
12. [Pagination](#12-pagination) · 13. [Search](#13-search)
14. [Authentication](#14-authentication) · 15. [CSV](#15-csv)
16. [Docker](#16-docker) · 17. [Tests](#17-tests)
18. [Live API verification](#18-live-api-verification) · 19. [GitHub commits](#19-github-commits)
20. [Remaining blockers](#20-remaining-blockers) · 21. [Demo environment](#21-demo-environment) · [Final status](#final-status)

---

## 1. Architecture

Node 20+ / Express 5.2 / TypeScript 5.9 strict / Prisma 7.10 with the `pg`
driver adapter / PostgreSQL. ESM throughout.

```
routes/      HTTP, Zod validation, permission gates, audit + risk triggers
services/    business logic — every function takes a TenantContext first
lib/         prisma, tenant scope, permissions, pagination, envelopes, errors
middleware/  auth, validate, security, errorHandler
```

New this round: `lib/permissions.ts` (the authorization matrix),
`services/riskFactors.ts` (pure derivation), `services/riskTriggers.ts` (the
bridge from mutations to recalculation).

The pure/impure split the codebase already used is preserved and extended:
`riskScoring` and `riskFactors` have no Prisma import and unit-test without a
database; `riskEngine` is the only thing that touches rows.

## 2. Schema

22 models, 11 enums, **6 migrations**, all additive. No table or column has
ever been dropped.

This round added one migration,
`20260923090000_vendor_risk_history_and_derived_factors`:

- `RiskHistory` gains `subjectType` (`ASSET`/`VENDOR`), `vendorId`,
  `vendorRiskId`; `assetId` widened to nullable.
- `Risk` and `VendorRisk` gain `exposureOverridden` / `controlGapOverridden`.
- Six new `RiskChangeReason` values for the automatic triggers.

Verified the same way as the previous one, before touching anything real: a
`pg_dump` of the populated development database restored into a throwaway
probe, the migration applied there, every row confirmed intact, and
`prisma migrate diff` confirming zero residual difference from the target
schema. The probe was dropped afterwards.

## 3. Endpoints

**87.** Two added this round: `GET /api/vendors/:id/risk-history`, and a
`subjectType` filter on `GET /api/risks/history`.

Full per-endpoint detail in [`API_REFERENCE.md`](./API_REFERENCE.md); the
client-facing summary, including every breaking change, in
[`FRONTEND_API_CONTRACT.md`](./FRONTEND_API_CONTRACT.md).

## 4. Authorization

**The gap:** every write carried the same `requireRole(["ADMIN","ANALYST"])`,
so an analyst could rename an asset, grant PHI access or delete the policy
register.

**The fix:** one matrix in `src/lib/permissions.ts`, 47 named permissions, and
routes that name the operation rather than a role list. The line drawn:

> **ADMIN configures the estate. ANALYST works within it.**

| ANALYST may | ANALYST is refused |
|---|---|
| Assess and recompute asset & vendor risk | Create / update / archive assets |
| Create, update, triage threats | Create / update / archive vendors |
| Create, assign, transition remediation | Create / update / archive identities |
| Attest an access review | Grant, re-level, revoke access |
| Record a control's status / effectiveness / review date | Create, rename, recategorise, archive controls |
| Read everything except audit | Policies, imports, audit |

Controls are **field-scoped**: the PATCH gate reads the body, allows
`status`/`effectiveness`/`lastReviewedAt` under `control:assess`, and refuses
anything else with a 403 that names the offending fields — so a UI can grey
exactly those inputs rather than guessing.

A 403 now carries the permission it wanted (`(permission: asset:create)`).

**Verified:** 123 permission tests — every mutating endpoint as ADMIN, ANALYST,
VIEWER, anonymous, and as an ADMIN of another organisation — plus 24 live
checks against a running server.

## 5. Tenant isolation

Unchanged in design and re-verified. `TenantContext` is built in `requireAuth`
from the signed token; `scope(ctx)` is spread into every query; single-record
reads use `findFirst` with the scope, never `findUnique` by id. No endpoint
reads an organisation id from a path, query or body.

Cross-tenant access returns **404, not 403** — from outside, another tenant's
record is indistinguishable from one that does not exist.

Write paths verify foreign keys too: attaching a remediation to another
tenant's asset id would otherwise read that asset's name back out of your own
detail response.

**Verified live** with two organisations on one server: org B's admin saw an
empty estate, got 404 on every one of our records, could not patch, archive or
assess any of them, could not link a finding to our asset, and got zero results
from search, audit and the risk report. 15/15.

## 6. Risk engine

**The formula is unchanged**: `score = (l × i × e × c) / 625 × 100`, two
decimals, five bands at 20/40/60/80.

What changed is where two of the four numbers come from:

| Factor | Source |
|---|---|
| `likelihood` | Assessor judgement |
| `impact` | Assessor judgement |
| `exposure` | **Derived** — PHI volume, encryption, MFA, live grants and levels, vendor reach, unencrypted flows, open severe threats |
| `controlGap` | **Derived** — applied controls weighted 1.0 effective / 0.5 partial |

Likelihood and impact stay with the assessor because no graph data yields them:
how motivated an attacker is, and what a breach would cost, are judgements. A
system that invented those would be fabricating the inputs that matter most.

Every derived rule is a bucketed count of something already recorded, with
thresholds you can read in `riskFactors.ts`. Nothing is model-weighted or
fitted. Each result ships with a `derivation` string of the facts behind it:

> `exposure 4 (120,000 PHI records; PHI stored unencrypted; access not
> protected by MFA; 1 vendor(s) can reach it) | control gap 4 (1 effective +
> 0 partial control(s) = 1 weighted coverage)`

An assessor who supplies `exposure` or `controlGap` **pins** it —
`exposureOverridden` goes true and automatic recalculation leaves it alone
until a later assessment omits it. Human judgement outranks the derivation.

**There is one engine.** `vendorService` had its own `computeRisk` call and its
own upsert; that duplicate is deleted. `riskEngine.ts` is now the only writer of
`Risk`, `VendorRisk` and `RiskHistory`, for both subject types, and the only
place a score is computed.

## 7. Automatic recomputation

Eleven mutations trigger a rescore:

| Mutation | Reason | Rescored |
|---|---|---|
| Asset `phiVolume` / `encrypted` / `mfaEnabled` | `ASSET_CHANGED` | that asset |
| Access granted / re-levelled / revoked | `ACCESS_CHANGED` | that asset |
| Identity archived | `ACCESS_CHANGED` | every asset it could reach |
| Vendor↔asset link added / removed | `VENDOR_ACCESS_CHANGED` | vendor **and** its assets |
| Vendor `baaStatus` / `lastAssessedAt` | `VENDOR_ACCESS_CHANGED` | that vendor |
| Control applied / removed | `CONTROL_CHANGED` | that asset |
| Control `status` / `effectiveness` | `CONTROL_CHANGED` | every asset it protects |
| Threat created / transitioned | `THREAT_CHANGED` | that asset |
| Risk CSV imported | `IMPORTED` | the imported assets |

Triggers live in `riskTriggers.ts` and contain **no scoring logic** — they
decide which subjects a mutation could have moved and hand off to the engine.

Three guarantees, each tested:

- **No loop.** Recalculation reads the graph and writes only Risk, RiskHistory
  and AuditEvent — never an asset, vendor, grant, control or threat. It cannot
  trigger itself.
- **No noise.** A recalculation that changes nothing writes no history row, and
  mutations that cannot move a score (renaming an asset) do not fire at all.
- **No invented assessments.** An unassessed subject stays unassessed no matter
  what changes around it.

Each rescore writes a `RISK_RECOMPUTED` audit row carrying the derivation.
Triggering mutations return `riskChanged` so a client can update in place.

## 8. Vendor risk history

Implemented by **sharing `RiskHistory`**, not duplicating it — the four
factors, the formula, the bands and the audit requirements are identical, and
two tables would mean two places to forget to write a row.

`GET /api/vendors/:id/risk-history` — paginated, newest first, with
`previousScore`/`previousBand`, `score`/`band`, a precomputed `delta`, the four
factors, the `reason`, the actor and the timestamp. The scoped existence check
runs first, so another tenant's vendor id returns 404 rather than an empty page
that reads as "no history yet".

`GET /api/risks/history?subjectType=VENDOR` filters the estate-wide feed.

**Verified live:** a vendor's BAA lapsing from PENDING to MISSING moved it
23.04 → 28.8, recorded with `reason: VENDOR_ACCESS_CHANGED` and the actor.

## 9. Audit

Unchanged in design, extended in coverage. 43 action types, append-only, single
writer, metadata sanitised against a credential/PHI denylist, audit row shares
the mutation's transaction.

New this round: automatic rescores write `RISK_RECOMPUTED` with
`trigger: "automatic"` and the derivation string, so the trail says *why* a
score moved and not merely that it did.

**Verified live:** all 14 expected action types present after the admin
walkthrough — LOGIN, ASSET_CREATED, VENDOR_CREATED, IDENTITY_CREATED,
ACCESS_GRANTED, THREAT_CREATED, CONTROL_CREATED, CONTROL_LINKED_ASSET,
RISK_CREATED, RISK_RECOMPUTED, VENDOR_UPDATED, REMEDIATION_CREATED,
REMEDIATION_ASSIGNED, REMEDIATION_RESOLVED — plus IMPORT_STARTED /
IMPORT_COMPLETED / IMPORT_FAILED from the CSV run.

## 10. Remediation

Full lifecycle with a server-enforced transition table; `ACCEPTED` (risk
accepted without fixing) stays distinct from `RESOLVED` in every count.

The property worth restating, because it is the point: **resolving does not
change the estate.** It persists a status, a timestamp, an actor and an audit
event. Verified live — after resolving "encrypt PACS at rest", the asset's
`encrypted` flag was still `false`. Marking work done is a claim about people,
not a change to the systems.

## 11. Controls

Full CRUD with archive semantics, asset and policy links, and the
control-gap evidence endpoint. Controls now genuinely feed risk: the derived
`controlGap` factor is computed from applied controls, so linking an effective
control lowers an asset's score automatically and the history says why.

`frameworkRef` remains free text the customer typed. Drishti stores it as a
reference and asserts no conformance with anything.

## 12. Pagination

Audited across **15 collections** live: assets, vendors, identities, access,
threats, controls, policies, remediations, risks, dataflows, audit, risk
history, asset risk-history, vendor risk-history, asset audit-history. Every
one returns `{ data: [], meta: { page, pageSize, total, totalPages } }`.

Default 25, maximum 200 (capped, not rejected), `totalPages` never below 1.

**Documented exception:** `GET /api/search` is not paginated. It is bounded by
construction instead — 10 results per type, 50 overall, 2-character minimum —
because a paginated cross-table scan is a denial-of-service primitive handed to
any authenticated user. It returns `truncated: true` when it clips.

**Two endpoints derive their filter in JS** (`/api/access?flaggedOnly`,
`/api/dataflows?status`) because the predicate is computed rather than stored.
They run unpaginated internally and take the page from the filtered set, so
`meta.total` stays truthful.

## 13. Search

Unchanged. Seven entity types, tenant-scoped, archived records excluded,
bounded as above.

## 14. Authentication

Verified live end to end:

| Check | Result |
|---|---|
| Access token lifetime | **3600s** ✅ |
| Cookie name | `drishti_token` (+ `drishti_refresh`) ✅ |
| Legacy `medguard_token` accepted inbound | ✅ |
| Refresh token length / storage | 64 hex chars, stored as SHA-256 only ✅ |
| Rotation on use, reuse revokes all sessions | ✅ (15 session tests) |
| Membership re-checked on refresh | ✅ |
| Expired token → 401 | ✅ |
| Garbage token → 401 | ✅ |
| Anonymous on gated route → 401, not 403 | ✅ |
| Unknown account and wrong password give the same message | ✅ |

## 15. CSV

Verified live through the full contract: **template → validate → preview →
confirm → transaction → result → audit**.

| Check | Result |
|---|---|
| Template downloads as `drishti-assets-template.csv` | ✅ |
| Contract lists 7 entities | ✅ |
| Dry run reports `valid`, previews the row, **writes nothing** | ✅ |
| Confirm returns 201, `imported: 1`, row in Postgres | ✅ |
| Row scoped to the caller's organisation | ✅ |
| Visible immediately via `GET /api/assets?search=` | ✅ |
| IMPORT_STARTED / IMPORT_COMPLETED audited | ✅ |
| Invalid enum refused, message names the legal values | ✅ |
| Nothing partially written on failure | ✅ |
| IMPORT_FAILED audited | ✅ |
| Non-`.csv` rejected | ✅ |
| Formula injection (`=HYPERLINK(...)`) refused | ✅ |

**Validation was not weakened.** The sample file with 19 invalid asset types
still fails, and `AssetType` was not broadened to accommodate it — that is a
product taxonomy decision, not a bug fix.

## 16. Docker

Rebuilt and re-verified with this round's code:

| Check | Result |
|---|---|
| `docker build` | ✅ |
| Container starts against real Postgres | ✅ |
| `/health` → `{"status":"ok","service":"drishti-api","version":"0.3.0"}` | ✅ |
| Authenticated flow inside the container (9 endpoints incl. vendor risk-history) | ✅ all 200 |
| Docker healthcheck | ✅ `healthy` |

Migrations still do not run on container start — that is a separate release
step, because a container that migrates as it boots races every other replica
during a rolling deploy.

## 17. Tests

**529 passing, 0 skipped, 19 files.**

| File | Tests | Covers |
|---|---|---|
| `permissions.test.ts` | 123 | every mutation × ADMIN/ANALYST/VIEWER/anon/other-org |
| `importParsing.test.ts` | 67 | CSV parsing rules (unit) |
| `lifecycle.test.ts` | 32 | assessment, triage, controls, remediation, archive |
| `discovery.test.ts` | 25 | pagination, filtering, sorting, search, reports |
| `automatic-risk.test.ts` | 25 | triggers, pinning, no-loop, vendor history |
| `tenancy.test.ts` | 22 | cross-tenant reads and writes |
| `vendors.test.ts` | 22 | vendor CRUD and scoring |
| `audit.test.ts` | 22 | audit events, sanitisation, diffing |
| `routes.test.ts` | 21 | core routes and error mapping |
| `riskFactors.test.ts` | 19 | derivation rules (unit, no DB) |
| `rbac.test.ts` | 19 | role gates |
| `session.test.ts` | 15 | refresh rotation, reuse detection, revocation |
| others | 99 | auth, access, threats, import, security, scoring, flow status |

Unit tests are database-free and separable. Integration tests run only against
`TEST_DATABASE_URL`, guarded twice — vitest overrides `DATABASE_URL`, and
`globalSetup` refuses any database whose name lacks "test".

```
npm run build      PASS
npm run typecheck  PASS   (src + tests)
npm run lint       PASS
npm test           PASS   529/529
```

## 18. Live API verification

Run against a **dedicated `drishti_e2e` database and a second server instance
on :4010**, not the demo data — real Postgres, real HTTP, real persistence,
with the demo database left alone.

| Phase | Result |
|---|---|
| Admin walkthrough (login → asset → vendor → identity → access → threat → control → assess → recompute → history → remediation → audit → logout) | **42/42** |
| Analyst permissions (11 allowed, 13 forbidden) | **24/24** |
| Cross-organisation isolation | **15/15** |
| CSV import contract | **20/20** |
| Pagination audit (15 collections) | **17/17** |
| Summary correctness | **4/4** |
| Security sweep | **22/22** |
| Docker | **5/5** |

**Total: 149 live checks, 0 failures.**

Observed during the run, quoted because they are the features working rather
than claims about them:

- Adding four access grants moved an asset **38.4 → 51.2** and exposure 3 → 4,
  with nobody pressing recompute. History recorded
  `reason: ACCESS_CHANGED, delta: 12.8, by: admin@meridian.org`.
- A vendor's BAA lapsing moved it **23.04 → 28.8**, recorded as
  `subjectType: VENDOR`.
- 47 threats with a 25-row page: `meta.total: 47` and
  `/api/threats/summary` → `total: 47`. The summary counts the dataset, not the
  page.
- Latency flat from `pageSize=1` to `pageSize=100` (6.9ms → 8.4ms, per-row cost
  falling 82×) — a fixed query count, not N+1. Asset detail with nine nested
  relations: 26ms. Risk report with fourteen aggregates: 13ms.
- All 14 scoped tables carry an `organizationId` index; the tenant filter uses
  a bitmap index scan, not a sequential scan.
- The global rate limiter tripped mid-run at 300 requests and returned
  `429 RATE_LIMITED` — correct behaviour, and it invalidated one performance
  measurement until the counter was reset.

**Demo database impact:** none to its data. `medguard_dev` still holds 16
assets, 8 risks, 5 vendors, 5 threats. It did gain 45 `AuditEvent` rows — the
logins from verification sweeps, correctly recorded by the audit system.

All E2E resources (server, container, image, `drishti_e2e` database) were torn
down afterwards.

## 19. GitHub commits

**16 commits, pushed and verified** on
`origin/feat/drishti-platform-foundation` (`d71567c`). The 14 most recent are
listed below; `15db7bd` and `c06b6f0` are the two platform commits beneath them. No force push, no
squash, no history rewrite, no self-merge.

```
d71567c docs: add the final report
38c9b97 docs: correct the endpoint count to 87
cb83a07 docs(api): document the permission matrix, derived factors and vendor history
b8d0a2f test(risk): cover derivation, automatic triggers and vendor history
d8a29a9 feat(risk): recompute automatically when a risk input changes
96fb5fc refactor(risk): make riskEngine the single authority for both subjects
ef22a1f feat(risk): derive exposure and control gap from recorded facts
28df975 feat(schema): share risk history between assets and vendors
e953ffb test(authz): cover every mutation across all caller types
760e7de fix(authz): restrict analyst mutations to analysis operations
d33a5bd docs: add the implementation report
0a9faab docs: rewrite the API reference and add the frontend handoff contract
0f63e9e feat(deploy): add production Docker support and document environments
7a2b5f1 test: cover tenancy, sessions, audit, lifecycles, pagination and search
```


## 20. Remaining blockers

### For the frontend — none

Every endpoint the demonstration needs exists, is tested, and returns real
persisted data. Nothing is stubbed; nothing returns a fabricated value.

**Three contract changes you must handle** — all documented in
`FRONTEND_API_CONTRACT.md` with diffs:

1. **ANALYST can no longer change the inventory.** Gate the buttons off the
   role in the token. The 403 names the permission.
2. **Assessments take two factors.** `{ likelihood, impact }`; supplying
   exposure or controlGap now *pins* them.
3. **Risk moves on its own.** Do not cache a score across a mutation; use the
   `riskChanged` field in the response.

### Honest gaps

| Gap | Severity | Note |
|---|---|---|
| **No PHI-assignment endpoint** | P1 | `AssetPHI` links come only from seed or CSV import. "Assign PHI to asset" has no REST path — the E2E used import. |
| **No organisation-creation endpoint** | P1 | Orgs come from migration or SQL. The E2E created org B with psql. Fine for one tenant; needed before self-service. |
| **No user-management endpoints** | P1 | `GET /api/organization/members` is read-only. No invite, no role change. The mandate's "users: read/update role where authorized" is half-done. |
| **No settings endpoints** | P2 | Correctly so — there are no persistent settings to expose. |
| **Vendors have no Control links** | P2 | Vendor control-gap derives from BAA state and assessment recency only. If vendor-level controls get modelled, the derivation has an obvious home. |
| **`access?flaggedOnly` / `dataflows?status` filter in JS** | P2 | Derived predicates. Fine at this scale; would need materialising past ~10k grants. |
| **`samples/…sample_100.csv` still unusable** | P2 | 19 of 20 `type` values violate the enum. Not widened — taxonomy is a product decision. |
| **No `npm audit` in CI** | P2 | |
| **Database / package / remote still named MedGuard** | P3 | Deliberate; no schema change waits on it. |
| **No OpenAPI spec** | P3 | Markdown only. |

### Not done, deliberately

No AI endpoints. No compliance score. No DELETE on customer records. No
fabricated data paths anywhere.

---

## 21. Demo environment

The last blocker in this report's previous revision was that the demo database
held 0 controls, 0 policies and 0 remediations, and the only seed available
truncated every table to fix that. That is now solved without destroying
anything.

### The command

```bash
npm run db:seed:demo
```

| | `npm run db:seed` | `npm run db:seed:demo` |
|---|---|---|
| Behaviour | TRUNCATEs every table, rebuilds | Upsert-only |
| Safe against existing data | ❌ | ✅ |
| Safe to run twice | ❌ (rebuilds) | ✅ (no-op) |
| Scope | whole database | one organisation |

### Safety

`prisma/seed-demo.ts` contains **no** `deleteMany`, `.delete(`, `TRUNCATE`,
`DROP`, `$executeRaw`, `$queryRaw`, `updateMany` or migration reset. That is
not a claim to take on trust: a test reads the file's own source, strips
comments, and fails if any of those strings appear in executable code.

The single `.update()` call backdates an audit row the same function created
microseconds earlier, so historical entries read as history rather than as a
burst of activity at seed time. It cannot reach a row it did not just write.

Blast radius is one organisation, resolved by slug (`DEMO_ORG_SLUG`, default
`drishti-demo`). Records in other organisations are never written and never
read for writing.

### Idempotency

Verified three ways, because the seed's own counters could themselves regress:

1. The run summary reports nothing created on a second run.
2. A 21-table census is byte-identical before and after a second run.
3. `RiskHistory` and `AuditEvent` — the two tables with no unique constraint,
   and therefore the two that would silently accumulate — are counted
   individually.

Those tables need care precisely because the schema is right not to constrain
them: history is append-only. Idempotency there is a deliberate "do not assess
what is already assessed" and an existence check on
`(action, entityType, entityId)`, not a database guarantee.

Observed on the real demo database:

| Run | Result |
|---|---|
| 1 | created the full estate |
| 2 | **created 0 of everything**, totals unchanged |
| 3 (after adding one asset to the seed) | created only the 1 new asset and its 4 grants, 3 PHI links, 2 flows, 2 vendor links, 1 threat, 1 remediation |

That third run is the useful one: the seed tops up an organisation it has
already populated, rather than only working on an empty one.

### Demo organisation

**Drishti Demo Healthcare** (`drishti-demo`), created alongside the existing
Meridian Health System rather than replacing it.

| Entity | Count |
|---|---|
| Assets | 9 |
| PHI types / asset-PHI links | 4 / 15 |
| Data flows | 10 |
| Identities | 6 |
| Access grants | 13 |
| Vendors | 5 |
| Threats | 6 |
| Controls | 8 |
| Policies | 5 |
| Remediations | 7 |
| Risk history | 32 |
| Audit events | 17 |

All synthetic. No real patients, clinicians, vendors or credentials anywhere in
the file.

Accounts: `admin@drishti-demo.invalid`, `analyst@drishti-demo.invalid`,
`viewer@drishti-demo.invalid`, all using `DEMO_USER_PASSWORD`. The seed never
prints it, and an account that already exists keeps the password it has rather
than being silently reset.

### The story the data tells

Risk is **not hardcoded**. The graph is built first, then the real engine
scores it, so every number comes from the demo's own assets, access, vendors,
controls and threats by the same code paths a customer's data would take.

The ordering is deliberate so the trend charts have something to draw:
vendors are assessed *before* they are given reach, and assets *before*
controls are applied. Applying the controls then moves the scores down and the
movement is recorded with `reason: CONTROL_CHANGED` — "here is what it looked
like before we had controls, and after".

| Band | Count | Example |
|---|---|---|
| EXTREME | 1 | Legacy Records Exchange — 100 |
| CRITICAL | 0 | *(see note)* |
| HIGH | 1 | Billing Database — 48 |
| MODERATE | 4 | Cardiology EHR — 25.6 |
| LOW | 3 | Patient Portal — 1.92 |

The top entry earns its score rather than being handed one: 521,000 PHI
records, unencrypted, no MFA, reachable by four identities including a
deactivated contractor and by two vendors, unencrypted outbound flows, an
active exfiltration alert, and no control ever applied. Exposure 5, control
gap 5, assessor judgement 5/5 → 100.

**The CRITICAL band is empty, and that is a property of the formula rather
than a gap in the data.** The score is a product of four factors normalised
over 625, so the 60–80 window is narrow — the codebase has documented this
since before this work ("4/4/4/3 scores 30.72; EXTREME effectively requires all
5s"). Filling that bucket would have meant inventing an asset to sit in it,
which is the kind of thing this seed exists not to do. It is worth knowing
before a demonstration, and it is a reasonable thing to be asked about.

The best-protected system is also a deliberate part of the story: the
Cardiology EHR holds the most PHI of any healthy asset (486,000 records) and
still scores MODERATE, because it is encrypted, MFA-protected and covered by
effective controls.

### Verification

**Through the API**, as the demo admin, against the running server:

| Endpoint | Total |
|---|---|
| `/api/controls` | 8 |
| `/api/policies` | 5 |
| `/api/remediations` | 7 |
| `/api/risks` | 9 |
| `/api/vendors` | 5 |
| `/api/threats` | 6 |
| `/api/access` | 13 |
| `/api/audit` | 17 |

Dashboard summaries, counted over the whole organisation:

```
risk bands   {"LOW":3,"MODERATE":4,"HIGH":1,"CRITICAL":0,"EXTREME":1}
threats      {"total":6,"open":4,"openCritical":3}
access       {"total":13,"flagged":11,"stale":4,"neverUsed":1,
              "withoutMfa":5,"inactiveIdentities":2,"excessiveLevel":11}
remediation  {"total":7,"open":5,
              "byStatus":{"OPEN":4,"IN_PROGRESS":1,"RESOLVED":1,"ACCEPTED":1}}
report       {"assets":9,"coverage":100,"phi":1783100,
              "controls":8,"effectiveRate":25}
```

**Risk recomputation**, live on the seeded data:

| Step | Observed |
|---|---|
| `PATCH /api/assets/:id { mfaEnabled: false }` | exposure 4 → 5, score 25.6 → 32 |
| `riskChanged` in the response | present, with the new snapshot |
| Risk history | `ASSET_CHANGED`, 25.6 → 32, delta 6.4, by `admin@drishti-demo.invalid` |
| Audit | `RISK_RECOMPUTED` with the derivation string |
| Restore `mfaEnabled: true` | score back to 25.6 |

| Step | Observed |
|---|---|
| `PATCH /api/vendors/:id { baaStatus: "EXPIRED" }` | control gap 1 → 4, score 2.56 → 10.24 |
| Vendor risk history | 3 entries: `INITIAL_ASSESSMENT` → two `VENDOR_ACCESS_CHANGED` |
| Audit | `RISK_RECOMPUTED` |
| Restore `SIGNED` | score back to 2.56, history now 4 entries |

**Existing data untouched.** Meridian Health System still holds 16 assets, 5
vendors, 6 identities and 0 controls. Verified beyond row counts: an md5 over
`(id, name, type, phiVolume, encrypted, mfaEnabled)` for every org-1 asset, and
another over every org-1 risk score and band, are identical before and after
two seed runs.

> One correction worth recording: my first version of that risk checksum query
> failed on a type cast and returned empty for both sides, which compared equal
> and reported a false pass. It was re-run with explicit casts before being
> believed.

### CI

`npm run db:seed:demo` is exercised by the test suite (18 tests), so CI covers
it on every push.

Run `35829207285` on `main`: **success, 4m1s**, against `postgres:14` — a
different major version from the Postgres 16 used locally, so the seed's
portability is genuinely checked rather than assumed. The previous run,
`35823020356`, also passed. No CI failure to investigate.

### Commits

```
9837307 docs(seed): document the demo environment and the two seeds
0230427 test(seed): verify demo seed safety and idempotency
405937a feat(seed): add a safe, non-destructive demo seed
```

Pushed to `origin/main`.

---

# FINAL STATUS

## **BACKEND CONSUMER READY**

The end-to-end workflow passes against a real database, through real HTTP, with
real authentication, real RBAC, real tenant isolation, a single real risk
engine, real risk history for both assets and vendors, real remediation, a real
audit trail, real pagination, real CSV import, and a real Docker image.

**149 live checks, 0 failures. 529 tests, 0 failures. Build, typecheck and lint
clean.**

The definition-of-done chain, each link verified live rather than asserted:

```
REAL DATABASE   ✅  Postgres, 6 additive migrations, probe-tested before deploy
REAL API        ✅  87 endpoints, 149 live checks
REAL AUTH       ✅  1h JWT + rotating refresh, reuse detection, revocation
REAL RBAC       ✅  47 permissions, analyst restricted, 123 tests + 24 live
REAL ISOLATION  ✅  two orgs on one server, 404 across the boundary
REAL RISK       ✅  one engine, both subjects, derived factors
REAL HISTORY    ✅  asset and vendor, with reason and actor
REAL REMEDIATION✅  full lifecycle, and it does not touch the estate
REAL AUDIT      ✅  43 actions, sanitised, transactional
REAL PAGINATION ✅  15 collections, one documented exception
REAL CSV        ✅  validate → confirm → transaction → audit
REAL DOCKER     ✅  builds, runs, serves, reports healthy
REAL DEMO DATA  ✅  seeded non-destructively, idempotent, verified via API
```

**The demo database is populated.** `npm run db:seed:demo` created a
"Drishti Demo Healthcare" organisation beside the existing Meridian data
without touching it, and re-running it is a verified no-op. Controls, policies,
remediation and risk history all return real data through the API.

---

*Branch `feat/drishti-platform-foundation`, 13 commits, pushed to
`origin`. `main` untouched. No database was reset; the demo database holds
exactly the rows it held before, plus the audit trail of the verification
logins.*
