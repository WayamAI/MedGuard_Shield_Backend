# Drishti — Frontend API Contract

**Handoff document for the frontend session.** Everything here is implemented,
tested and running. Nothing below is aspirational — if it is in this file, you
can call it.

| | |
|---|---|
| Base URL (dev) | `http://localhost:4000` |
| Endpoints | **88** (was 22) |
| Tests | 529 passing |
| Branch | `feat/drishti-platform-foundation` (not merged — see the report) |

**Read [Breaking changes](#breaking-changes) first.** There are two rounds:
four from the platform rebuild, and three more from the productionisation pass
that closed the analyst-permissions, automatic-recomputation and
vendor-risk-history gaps. Everything else is additive.

---

## Contents

1. [Breaking changes](#breaking-changes)
2. [Envelopes](#envelopes)
3. [Authentication](#authentication)
4. [Tenancy](#tenancy)
5. [Roles](#roles)
6. [Pagination, filtering, sorting](#pagination-filtering-sorting)
7. [Errors](#errors)
8. [Endpoint reference](#endpoint-reference)
9. [The demo walkthrough, endpoint by endpoint](#the-demo-walkthrough-endpoint-by-endpoint)
10. [What is deliberately absent](#what-is-deliberately-absent)

---

## Breaking changes

Seven across two rounds. Each is listed with what to change.

---

# Round 2 — productionisation (read these first, they are newer)

### A. ANALYST can no longer change the inventory

**This is the big one.** Writes used to be a single tier: anything an ADMIN
could do, an ANALYST could do. That is now split along a line:

> **ADMIN configures the estate. ANALYST works within it.**

| ANALYST can | ANALYST now gets 403 |
|---|---|
| Assess asset & vendor risk, recompute | Create / update / archive assets |
| Create, update and triage threats | Create / update / archive vendors |
| Create, assign, resolve, reopen remediation | Create / update / archive identities |
| Attest an access review | Grant, re-level or revoke access |
| Record a control's status / effectiveness / review date | Create, rename, recategorise or archive a control |
| Read everything except the audit trail | Create / update / archive policies, run imports, read audit |

**What to change:** gate the buttons. The 403 body now names the permission —
`"Requires one of: ADMIN (permission: asset:create)"` — so you can drive
enablement off the role in the token rather than trial and error. Roles come
from `GET /api/auth/me`.

**Controls are field-scoped.** An ANALYST may PATCH `status`, `effectiveness`
and `lastReviewedAt`; anything else is 403 and the message names the offending
fields, so you can disable just those inputs.

### B. Assessments take two factors, not four

`POST /api/assets/:id/assessment` and the vendor equivalent now require only
`likelihood` and `impact`. `exposure` and `controlGap` are **derived from
recorded facts** and computed server-side.

```diff
- { "likelihood": 4, "impact": 5, "exposure": 4, "controlGap": 3 }
+ { "likelihood": 4, "impact": 5 }
```

Sending the old four-field body still works and is **not** an error — but it
now means something specific: supplying `exposure` or `controlGap` **pins**
that factor, and automatic recomputation will stop touching it. The response
carries `exposureOverridden` / `controlGapOverridden` so you can show which
numbers are the assessor's and which the system derives. Omitting a factor in
a later assessment releases the pin.

Responses also carry `derivation` — a plain-language string of the facts
behind the derived numbers, e.g. `"exposure 4 (120,000 PHI records; PHI stored
unencrypted; access not protected by MFA; 1 vendor(s) can reach it)"`. Render
it as the "why"; do not compose your own.

### C. Risk now moves on its own

Scores change without anyone pressing recompute. Eleven mutations trigger it —
asset PHI volume / encryption / MFA, access granted, re-levelled or revoked, an
identity archived, vendor reach added or removed, vendor BAA state, a control
applied, removed or reassessed, and a severe threat opening or closing.

**What to change:** do not cache a risk score across a mutation. Responses from
triggering mutations carry `riskChanged` — the new snapshot, or `null` if
nothing moved — so you can update in place without a refetch:

```js
const res = await patchAsset(id, { phiVolume: 400000 });
if (res.data.riskChanged) showRiskMoved(res.data.riskChanged);
```

`riskChanged` is a single snapshot on asset/access/threat/control routes and an
**array** on vendor-link routes (both sides of the relationship can move).

New `RiskChangeReason` values you will see in history: `ASSET_CHANGED`,
`PHI_CHANGED`, `ACCESS_CHANGED`, `VENDOR_ACCESS_CHANGED`, `CONTROL_CHANGED`,
`THREAT_CHANGED`.

---

# Round 1 — the platform rebuild

### 1. `/api/access` and `/api/threats` now return arrays, not objects

**Before:** `data` was an object — `{ summary: {...}, grants: [...] }` and
`{ summary: {...}, threats: [...] }`.

**Now:** `data` is a paginated array like every other list, and the summary has
its own endpoint.

```diff
- const { summary, grants } = res.data;
+ const grants  = res.data;          // GET /api/access
+ const summary = summaryRes.data;   // GET /api/access/summary
```

Same for threats: `GET /api/threats` → array, `GET /api/threats/summary` → the
counts.

**Why:** once a list is paginated, a summary computed alongside it silently
describes one page rather than the estate. The dashboard needs the estate
figure, so it became its own endpoint that counts in SQL.

### 2. Access token lifetime is 1 hour, not 8

`expiresIn` is now `3600`. A refresh token (30 days, rotating) does the work
the 8-hour token used to. **If you use cookies you need no code change** — the
browser sends both and `/api/auth/refresh` swaps them. If you hold the token
in memory, call `POST /api/auth/refresh` on a 401 and retry once.

**Why:** an 8-hour bearer token that cannot be revoked is 8 hours of exposure
after a leak. The refresh token can be revoked, is stored only as a hash, and
rotates on every use.

### 3. Cookie renamed `medguard_token` → `drishti_token`

A second cookie, `drishti_refresh`, is also set. **The old name is still
accepted on the way in**, so existing sessions keep working; it is never set
any more. If you read the cookie name anywhere, update it.

### 4. CSV templates download as `drishti-<entity>-template.csv`

Only affects you if you assert on the filename.

### Not breaking, worth knowing

- `POST /api/risks/:assetId/recompute` still works. It is now an alias for
  `POST /api/assets/:id/recompute` and is **deprecated** — move when convenient.
- Every list endpoint now returns a `meta` sibling. Existing code that reads
  `data` and ignores `meta` keeps working, but will only see the first 25 rows.
  **This is the one silent behaviour change**: previously you got everything.
- `/health` gained `service` and `version` fields.

---

## Envelopes

Single record:

```json
{ "data": { "id": 1, "name": "Epic EHR Core" } }
```

Collection — always an array in `data`, always a `meta` sibling:

```json
{
  "data": [ ... ],
  "meta": { "page": 1, "pageSize": 25, "total": 137, "totalPages": 6 }
}
```

Error — always this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
             "details": [{ "path": "type", "message": "Invalid option: ..." }] } }
```

Dates are ISO 8601 UTC out; `YYYY-MM-DD` accepted in.

---

## Authentication

```
POST /api/auth/login   { email, password, organizationId? }
```

Returns, and sets `drishti_token` + `drishti_refresh` as httpOnly cookies:

```json
{
  "data": {
    "token": "eyJ...",
    "expiresIn": 3600,
    "refreshToken": "a1b2...64 hex chars",
    "refreshExpiresIn": 2592000,
    "user": { "id": 1, "email": "admin@meridian.org", "role": "ADMIN", "organizationId": 1 },
    "memberships": [
      { "organizationId": 1, "organizationName": "Meridian Health System",
        "organizationSlug": "meridian", "role": "ADMIN" }
    ]
  }
}
```

Transport either way: `Authorization: Bearer <token>` **or** the cookie.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/refresh` | Exchange the refresh token for a new pair. Cookie or `{ refreshToken }` body. |
| `POST /api/auth/logout` | Revokes the refresh token, clears cookies. |
| `POST /api/auth/logout-all` | Revokes **every** session for the account. Returns `revokedSessions`. |
| `GET /api/auth/me` | Current session plus organisation and all memberships. |

**Rotation is strict.** Presenting an already-rotated refresh token revokes
every session for that user and returns 401 with
`"Refresh token has already been used..."`. Treat that as "log in again", not
as a retryable error — it means the token chain was replayed.

**Membership is re-checked on refresh.** Access withdrawn mid-session takes
effect at the next refresh (403), not at the next login.

**There is no signup, password reset or MFA endpoint.** Accounts are seeded.

---

## Tenancy

Every record belongs to an organisation. The organisation comes from the signed
token and **is never read from a URL, query or body** — there is no
`?organizationId=` parameter anywhere, by design.

Consequences for you:

- You never send an organisation id. Sending one has no effect (it is stripped).
- Another tenant's record returns **404, not 403** — from outside, it is
  indistinguishable from one that does not exist.
- `GET /api/organization` gives the current org plus entity counts;
  `GET /api/organization/members` gives the user list for owner pickers.

Org switching is not implemented as an endpoint yet: `memberships` is returned
at login, but to change organisation you log in again with `organizationId`.
Only one organisation exists in the demo data.

---

## Roles

Three, flat, no hierarchy. The role is per-organisation, and the line is
**configuration versus assessment**.

| Operation | VIEWER | ANALYST | ADMIN |
|---|:-:|:-:|:-:|
| Read anything except the audit trail | ✅ | ✅ | ✅ |
| Assess / recompute asset and vendor risk | ❌ | ✅ | ✅ |
| Create, update, triage threats | ❌ | ✅ | ✅ |
| Create, assign, transition remediation | ❌ | ✅ | ✅ |
| Attest an access review | ❌ | ✅ | ✅ |
| Record a control's status / effectiveness / review date | ❌ | ✅ | ✅ |
| Create / update / archive assets, vendors, identities | ❌ | ❌ | ✅ |
| Grant, re-level or revoke access | ❌ | ❌ | ✅ |
| Create / rename / archive controls and policies | ❌ | ❌ | ✅ |
| Import CSV | ❌ | ❌ | ✅ |
| Read the audit trail | ❌ | ❌ | ✅ |

The full matrix lives in `src/lib/permissions.ts` as one table. A 403 names the
permission it wanted, e.g. `(permission: asset:create)`.

A role failure is `403 FORBIDDEN` naming the roles required. **An
unauthenticated call to a gated route is 401, never 403** — do not treat 401 as
"wrong role".

Demo accounts share `DEMO_USER_PASSWORD`: `admin@meridian.org` (ADMIN),
`f.alrashid@meridian.org` (ANALYST), `a.patel@meridian.org` (VIEWER).

---

## Pagination, filtering, sorting

Every list endpoint accepts `?page=` (default 1) and `?pageSize=` (default
**25**, max **200**, silently capped rather than rejected).

`totalPages` is at least 1, so an empty result reads "page 1 of 1".

Per-endpoint filters:

| Endpoint | Filters |
|---|---|
| `/api/assets` | `search`, `type`, `band`, `includeArchived`, `sort=name\|phiVolume\|riskScore\|createdAt`, `order` |
| `/api/vendors` | `search`, `baaStatus`, `includeArchived`, `sort`, `order` |
| `/api/identities` | `search`, `kind`, `active`, `includeArchived` |
| `/api/access` | `assetId`, `identityId`, `level`, `flaggedOnly`, `includeRevoked`, `search` |
| `/api/threats` | `status`, `severity`, `assetId`, `openOnly`, `search` |
| `/api/controls` | `search`, `category`, `status`, `effectiveness`, `includeArchived` |
| `/api/policies` | `search`, `status`, `includeArchived` |
| `/api/remediations` | `status`, `severity`, `source`, `ownerId`, `assetId`, `vendorId`, `openOnly`, `overdueOnly`, `search` |
| `/api/risks` | `band`, `assetId` |
| `/api/dataflows` | `status`, `assetId` |
| `/api/audit` | `action`, `entityType`, `entityId`, `actorUserId`, `from`, `to` |

`sort=riskScore` sorts **unassessed assets last in both directions** — "no
score" is not a low score.

---

## Errors

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Schema failure. Carries `details[]`. |
| `BAD_REQUEST` | 400 | Upload problem: no file, wrong extension. |
| `MALFORMED_JSON` | 400 | Unparseable body. |
| `IMPORT_VALIDATION_FAILED` | 400 | CSV rows failed. Carries full `report`. Nothing written. |
| `UNAUTHORIZED` | 401 | No/invalid/expired token, or a replayed refresh token. |
| `FORBIDDEN` | 403 | Wrong role, or no membership. |
| `NOT_FOUND` | 404 | Does not exist **or belongs to another tenant**. |
| `ROUTE_NOT_FOUND` | 404 | No such route. |
| `CONFLICT` | 409 | Duplicate name, illegal state transition, already archived. |
| `PAYLOAD_TOO_LARGE` | 413 | JSON body over 100 KB. |
| `FILE_TOO_LARGE` | 413 | CSV over 2 MB. |
| `RATE_LIMITED` | 429 | 300/15min global; 10 failed logins/15min. |
| `INTERNAL_ERROR` | 500 | Generic by design. |

**409 is informative.** Illegal state transitions name the legal ones:
`"Cannot move a threat from RESOLVED to INVESTIGATING. Allowed: OPEN"`. Use it
to render the right buttons.

---

## Endpoint reference

### Organization

| Method | Path | Role |
|---|---|---|
| GET | `/api/organization` | any |
| GET | `/api/organization/members` | any |

### Assets

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/assets` | any | paginated |
| POST | `/api/assets` | ANALYST+ | `{ name, type, phiVolume?, encrypted?, mfaEnabled?, lastAssessedAt? }` |
| GET | `/api/assets/:id` | any | full graph — see below |
| PATCH | `/api/assets/:id` | ANALYST+ | any subset, at least one field |
| POST | `/api/assets/:id/archive` | ADMIN | no DELETE exists |
| POST | `/api/assets/:id/restore` | ADMIN | |
| POST | `/api/assets/:id/assessment` | ANALYST+ | **new** — `{ likelihood, impact, exposure, controlGap }` each 1–5. 201 first time, 200 after |
| POST | `/api/assets/:id/recompute` | ANALYST+ | 404 if never assessed |
| GET | `/api/assets/:id/risk-history` | any | score movement |
| GET | `/api/assets/:id/history` | any | **new** — audit trail |
| GET | `/api/assets/:id/control-evidence` | any | **new** — suggested control gap |
| PUT/DELETE | `/api/assets/:id/controls/:controlId` | ANALYST+ | apply/remove a control |

`GET /api/assets/:id` returns the whole graph in one call: `phiTypes[]`,
`risk` (with the four 1–5 factors), `flows.outbound[]` / `flows.inbound[]`,
`vendors[]`, `access[]`, `threats[]`, `controls[]`, `remediations[]`.

The list adds a `counts` object per row — `{ phiTypes, flows, accessGrants,
openThreats, controls }` — so cards need no extra calls.

`risk` is `null` for an unassessed asset, and such assets do not appear in
`/api/risks` at all.

### Risks

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/risks` | any | paginated, score desc |
| GET | `/api/risks/distribution` | any | **new** — `{ LOW, MODERATE, HIGH, CRITICAL, EXTREME }` counts |
| GET | `/api/risks/history` | any | estate-wide movement, assets and vendors. `?subjectType=ASSET\|VENDOR` |
| POST | `/api/risks/:assetId/recompute` | ANALYST+ | **deprecated alias** |

Risk history entry:

```json
{
  "id": 12, "assetId": 3, "assetName": "Epic EHR Core",
  "previousScore": 65, "previousBand": "EXTREME",
  "score": 72, "band": "EXTREME", "delta": 7,
  "likelihood": 4, "impact": 5, "exposure": 4, "controlGap": 3,
  "reason": "MANUAL_ASSESSMENT",
  "changedBy": { "id": 1, "email": "admin@meridian.org" },
  "changedAt": "2026-09-22T10:14:00.000Z"
}
```

`reason` is one of `INITIAL_ASSESSMENT`, `MANUAL_ASSESSMENT`, `RECOMPUTE`,
`IMPORTED`, `ASSET_CHANGED`, `PHI_CHANGED`, `ACCESS_CHANGED`,
`VENDOR_ACCESS_CHANGED`, `CONTROL_CHANGED`, `THREAT_CHANGED`.

History entries carry `subjectType` (`ASSET` or `VENDOR`), `subjectId` and
`subjectName`. Asset and vendor movement share one table and one endpoint
shape; `/api/vendors/:id/risk-history` and `/api/assets/:id/risk-history` are
the per-subject views.

**There is still no free-text explanation field.** Compose your "65 → 72
because…" wording from `reason` plus the `derivation` string on the snapshot —
both are facts the system observed. The backend will not assert a cause it did
not see.

A recompute that changes nothing writes no history row.

### Vendors

| Method | Path | Role |
|---|---|---|
| GET | `/api/vendors`, `/api/vendors/:id` | any |
| POST | `/api/vendors` | ANALYST+ |
| PATCH | `/api/vendors/:id` | ANALYST+ |
| POST | `/api/vendors/:id/assessment` | ANALYST+ |
| POST | `/api/vendors/:id/recompute` | ANALYST+ |
| POST | `/api/vendors/:id/archive` \| `/restore` | ADMIN |
| PUT/DELETE | `/api/vendors/:id/assets/:assetId` | **ADMIN** |
| GET | `/api/vendors/:id/risk-history` | any | **new** — vendor score movement |
| GET | `/api/vendors/:id/history` | any |

Derived read-only fields: `daysSinceAssessment`, `assessmentOverdue` (>365
days or never), `baaCompliant` (`baaStatus === "SIGNED"`), `phiExposure` (sum
of reachable asset PHI, detail only), `openRemediations`.

Archiving a vendor that still has asset access returns **409** — remove the
access first, because that is the action that reduces exposure.

### Identities and access

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/identities`, `/api/identities/:id` | any | **new** |
| POST | `/api/identities` | ANALYST+ | **new** |
| PATCH | `/api/identities/:id` | ANALYST+ | **new** |
| POST | `/api/identities/:id/archive` | ADMIN | **new** — also revokes every grant, atomically |
| GET | `/api/access` | any | paginated |
| GET | `/api/access/summary` | any | **new** — estate-wide |
| GET | `/api/access/:id` | any | **new** |
| POST | `/api/access` | ANALYST+ | **new** — `{ identityId, assetId, level? }` |
| PATCH | `/api/access/:id` | ANALYST+ | **new** — change level |
| POST | `/api/access/:id/revoke` | ANALYST+ | **new** — sets `revokedAt`, row kept |
| POST | `/api/access/:id/review` | ANALYST+ | **new** — attestation |

Grant flags: `STALE` (unused >90d), `NEVER_USED`, `NO_MFA` (human identities
only), `INACTIVE_IDENTITY`, `EXCESSIVE_LEVEL` (non-READ on >50k PHI records).
`riskFlagCount` is what the list sorts by, worst first.

"Never reviewed" is **not** a flag — it would fire on every row of a fresh
estate and drown the four that mean something. Use `lastReviewedAt` per row and
`neverReviewed` in the summary.

Archiving an identity returns `{ identity, revokedGrants }`.

### Threats

| Method | Path | Role |
|---|---|---|
| GET | `/api/threats` | any |
| GET | `/api/threats/summary` | any |
| GET | `/api/threats/:id` | any |
| POST | `/api/threats` | ANALYST+ |
| PATCH | `/api/threats/:id` | ANALYST+ |
| POST | `/api/threats/:id/status` | ANALYST+ |
| GET | `/api/threats/:id/history` | any |

`POST /:id/status` takes `{ status }`. Legal moves:

```
OPEN          → INVESTIGATING, RESOLVED, FALSE_POSITIVE
INVESTIGATING → OPEN, RESOLVED, FALSE_POSITIVE
RESOLVED      → OPEN
FALSE_POSITIVE→ OPEN
```

Closing stamps `resolvedAt`; reopening clears it. The detail response carries
`allowedTransitions[]` so you can render exactly the legal buttons.

### Controls

| Method | Path | Role |
|---|---|---|
| GET | `/api/controls`, `/api/controls/:id` | any |
| POST | `/api/controls` | ANALYST+ |
| PATCH | `/api/controls/:id` | ANALYST+ |
| POST | `/api/controls/:id/archive` | ADMIN |
| PUT/DELETE | `/api/controls/:id/assets/:assetId` | ANALYST+ |

`category`: ACCESS, ENCRYPTION, MONITORING, GOVERNANCE, RESILIENCE, VENDOR.
`status`: IMPLEMENTED, PARTIAL, PLANNED, NOT_IMPLEMENTED.
`effectiveness`: EFFECTIVE, PARTIALLY_EFFECTIVE, INEFFECTIVE, NOT_ASSESSED.

`frameworkRef` is free text the customer typed (e.g. `"HIPAA 164.312(a)(1)"`).
**Render it as a reference, never as a compliance claim** — the backend asserts
nothing on the strength of it.

`GET /api/assets/:id/control-evidence` returns:

```json
{ "assetId": 3, "appliedControls": 4, "effectiveControls": 2, "partialControls": 1,
  "weightedCoverage": 2.5, "suggestedControlGap": 3, "applied": false,
  "basis": "Weighted count of applied controls that are IMPLEMENTED and EFFECTIVE (1.0) or PARTIAL/PARTIALLY_EFFECTIVE (0.5).",
  "controls": [ ... ] }
```

`applied: false` is literal and always false: this is a **suggestion**. To act
on it, POST it as an assessment. Risk never moves because a checkbox changed.

### Policies

| Method | Path | Role |
|---|---|---|
| GET | `/api/policies`, `/api/policies/:id` | any |
| POST | `/api/policies` | ANALYST+ |
| PATCH | `/api/policies/:id` | ANALYST+ |
| POST | `/api/policies/:id/archive` | ADMIN |
| PUT/DELETE | `/api/policies/:id/controls/:controlId` | ANALYST+ |

`status`: DRAFT, ACTIVE, UNDER_REVIEW, ARCHIVED. `reviewOverdue` is derived
from `reviewDueAt`.

### Remediation

| Method | Path | Role |
|---|---|---|
| GET | `/api/remediations` | any |
| GET | `/api/remediations/summary` | any |
| GET | `/api/remediations/:id` | any |
| POST | `/api/remediations` | ANALYST+ |
| PATCH | `/api/remediations/:id` | ANALYST+ |
| POST | `/api/remediations/:id/status` | ANALYST+ |
| POST | `/api/remediations/:id/assign` | ANALYST+ |
| GET | `/api/remediations/:id/history` | any |

Create takes `{ title, description, recommendation, severity?, source?, ownerId?,
dueAt?, assetId?, vendorId?, threatId?, controlId?, identityId?, accessGrantId? }`.
Links are verified to belong to your organisation — a foreign id returns 404.

Legal moves:

```
OPEN / IN_PROGRESS / REOPENED → RESOLVED, ACCEPTED (and between themselves)
RESOLVED / ACCEPTED           → REOPENED
```

`ACCEPTED` means risk accepted without fixing and is deliberately distinct from
`RESOLVED` in every count.

> **This replaces the fabricated "Violation resolved, encryption applied."**
> Resolving a remediation persists a status, a timestamp, an actor and an audit
> event. It does **not** change the asset — `encrypted` stays `false` until
> someone actually encrypts it. If the UI needs to say the estate changed, the
> estate has to change: PATCH the asset, or record an assessment.

Each row carries `open`, `overdue` and a `subject` object naming the linked
entity.

### Audit

| Method | Path | Role |
|---|---|---|
| GET | `/api/audit` | **ADMIN** |
| GET | `/api/{assets,vendors,threats,remediations}/:id/history` | any |

43 action types. Every entry: `action`, `actor`, `entityType`, `entityId`,
`result`, `metadata`, `ip`, `createdAt`. Updates carry
`metadata.changes = { field: { from, to } }`.

Read-only — there is no write path, and credentials and patient identifiers are
stripped before storage.

### Search

```
GET /api/search?q=<2+ chars>&types=asset,vendor&limit=50
```

```json
{ "data": { "query": "epic", "truncated": false,
  "results": [ { "type": "asset", "id": 3, "title": "Epic EHR Core",
                 "status": "EXTREME", "context": "EHR · 412,000 PHI records" } ] } }
```

Types: asset, vendor, identity, threat, remediation, control, policy. Max 10
per type, 50 overall. Archived records are excluded. Under 2 characters → 400.

### Reports

```
GET /api/reports/risk-assessment
```

Returns counted-at-request-time figures: `assets` (total/archived/assessed/
unassessed/`assessmentCoverage`), `phi`, `flows`, `riskDistribution`,
`topRisks[]`, `vendors`, `access`, `controls`, `threats`, `remediation`.

**There is no compliance score and there will not be one.** The percentages are
coverage ratios over recorded data. The payload carries a `disclaimer` string —
render it wherever you render the numbers.

### Import

Unchanged apart from the filename and tenant scoping. Four ADMIN-only
endpoints, seven entities, `validate → preview → confirm → transaction →
result`, all-or-nothing. See `IMPORT_GUIDE.md`.

Imports are now audited (`IMPORT_STARTED`, `IMPORT_COMPLETED`, `IMPORT_FAILED`)
and imported risk rows get history with `reason: "IMPORTED"`.

---

## The demo walkthrough, endpoint by endpoint

All sixteen steps of the customer demonstration, mapped to live endpoints:

| # | Step | Call |
|---|---|---|
| 1 | Authenticate | `POST /api/auth/login` |
| 2 | See organization data | `GET /api/organization` |
| 3 | Discover assets | `GET /api/assets` |
| 4 | Inspect PHI | `GET /api/assets/:id` → `phiTypes[]` |
| 5 | Inspect flows | `GET /api/dataflows` |
| 6 | Inspect risks | `GET /api/risks`, `/distribution` |
| 7 | Inspect vendors | `GET /api/vendors` |
| 8 | Inspect access | `GET /api/access`, `/summary` |
| 9 | Inspect threats | `GET /api/threats`, `/summary` |
| 10 | Inspect controls | `GET /api/controls` |
| 11 | Identify findings | `GET /api/remediations?openOnly=true` |
| 12 | Create remediation work | `POST /api/remediations` |
| 13 | Assign it | `POST /api/remediations/:id/assign` |
| 14 | Resolve it | `POST /api/remediations/:id/status` |
| 15 | See audit history | `GET /api/audit`, `GET /api/assets/:id/history` |
| 16 | Import data | `POST /api/import/:entity` |
| 17 | See risk change | `POST /api/assets/:id/assessment` → `GET /api/assets/:id/risk-history` |

Seeded demo data supports all of it: 8 assets, 4 PHI types, 10 flows, 5
vendors, 6 identities, 9 grants, 5 threats, **8 controls** (mixed maturity),
**4 policies**, **6 remediations** spanning OPEN / IN_PROGRESS / RESOLVED /
ACCEPTED, and risk across all five bands.

---

## What is deliberately absent

Do not build UI that assumes these exist.

| Absent | Why |
|---|---|
| **DELETE on any record** | Archive (assets, vendors, identities, controls, policies) or revoke (access). The compliance record is the product. |
| **Compliance score** | Cannot be computed honestly. Coverage ratios only. |
| **AI / copilot endpoints** | Out of scope by instruction. None exist, and none return canned text. |
| **Notifications** | Not built. Derive banners from `overdueOnly`, `openOnly`, `assessmentOverdue`, `reviewOverdue`. |
| **Org-switch endpoint** | Log in again with `organizationId`. |
| **Signup / password reset / MFA** | Accounts are seeded. |
| **Threat/remediation status history as a timeline** | Transitions are in the audit trail (`/:id/history`), not a dedicated endpoint. |
| **PHI type CRUD** | Import only. No REST endpoints. |
| **Free-text risk-change explanations** | `reason` enum + factor deltas. Compose wording client-side. |

If you need one of these, ask — it is a backend task, not something to fake.
