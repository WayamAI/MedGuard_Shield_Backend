# Drishti API Reference

Complete reference for the Drishti PHI risk-intelligence API. Every endpoint
below is implemented and covered by tests; the response bodies shown were
captured from a running server, not written from the schema.

| | |
|---|---|
| Version | 0.3.0 |
| Base URL (dev) | `http://localhost:4000` |
| Endpoints | 88 (1 public, 87 authenticated) |
| Content type | JSON, except CSV upload (`multipart/form-data`) and template download (`text/csv`) |

**If you are building the client, read
[`FRONTEND_API_CONTRACT.md`](./FRONTEND_API_CONTRACT.md) first** — it leads
with the breaking changes (two rounds of them) and maps the demo walkthrough
to endpoints. This document is the per-endpoint detail.

---

## Contents

1. [Conventions](#conventions)
2. [Authentication](#authentication)
3. [Tenancy](#tenancy)
4. [Roles](#roles)
5. [Pagination](#pagination)
6. [Errors](#errors)
7. [Enumerations](#enumerations)
8. [Endpoints](#endpoints) — [health](#health) · [auth](#auth) · [organization](#organization) · [assets](#assets) · [risks](#risks) · [data flows](#data-flows) · [vendors](#vendors) · [identities](#identities) · [access](#access) · [threats](#threats) · [controls](#controls) · [policies](#policies) · [remediation](#remediation) · [audit](#audit) · [search](#search) · [reports](#reports) · [import](#import)
9. [Derived fields](#derived-fields)
10. [Known limits](#known-limits)

---

## Conventions

**Success.** Single record: `{ "data": { ... } }`. Collection:
`{ "data": [ ... ], "meta": { page, pageSize, total, totalPages } }`.

**Failure.** Always `{ "error": { "code", "message" } }`, plus `details[]` on
validation failures and `report` on failed imports. Stack traces are never
returned.

**Dates.** ISO 8601 UTC on the way out; `YYYY-MM-DD` accepted on the way in.

**Getting a token for the examples.**

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"<DEMO_USER_PASSWORD>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')
```

---

## Authentication

All `/api` routes require a session except `/api/auth/login`,
`/api/auth/logout` and `/api/auth/refresh`. `/health` is outside `/api`
entirely and is always public.

Two token transports, both accepted:

| Transport | Header |
|---|---|
| Bearer | `Authorization: Bearer <accessToken>` |
| Cookie | `Cookie: drishti_token=<accessToken>` |

| Token | Lifetime | Storage | Revocable |
|---|---|---|---|
| Access (JWT) | **1 hour** | `drishti_token` cookie + response body | no |
| Refresh (opaque, 32 random bytes) | **30 days** | `drishti_refresh` cookie + response body | yes |

Refresh tokens are stored only as a SHA-256 digest and **rotate on every use**.
Presenting an already-rotated token revokes every session for that user.

Cookies are `httpOnly` always, and `Secure; SameSite=None` when
`NODE_ENV=production` (which is what allows the app and API to be on different
domains, and requires HTTPS on both).

> The pre-rename `medguard_token` cookie is still accepted on the way in so
> existing sessions survive the rebrand. It is never set.

---

## Tenancy

Every customer record belongs to an `Organization`. The organisation is taken
from the signed token and **never** from a path, query or body — there is no
`organizationId` parameter on any endpoint.

Records belonging to another organisation return **404, not 403**: from
outside, they are indistinguishable from records that do not exist. This
applies to writes too — a foreign id in a request body is rejected, not stored.

---

## Roles

The line is **configuration versus assessment**: ADMIN decides what the estate
*is*, ANALYST works within it.

| Capability | VIEWER | ANALYST | ADMIN |
|---|:-:|:-:|:-:|
| Read any endpoint except audit | ✅ | ✅ | ✅ |
| Assess / recompute asset and vendor risk | ❌ | ✅ | ✅ |
| Create, update and triage threats | ❌ | ✅ | ✅ |
| Create, assign and transition remediation | ❌ | ✅ | ✅ |
| Attest an access review | ❌ | ✅ | ✅ |
| Record a control's status / effectiveness / review date | ❌ | ✅ | ✅ |
| Create / update / archive assets, vendors, identities | ❌ | ❌ | ✅ |
| Grant, re-level or revoke access | ❌ | ❌ | ✅ |
| Create / rename / archive controls and policies | ❌ | ❌ | ✅ |
| CSV import (all four endpoints) | ❌ | ❌ | ✅ |
| Read the audit trail | ❌ | ❌ | ✅ |

Roles are per-organisation and flat — there is no hierarchy. The matrix is one
table in `src/lib/permissions.ts`; routes name the operation
(`requirePermission("asset:create")`) and a 403 names the permission it wanted.

**Controls are field-scoped for ANALYST:** `status`, `effectiveness` and
`lastReviewedAt` are assessment; everything else on a control is configuration
and needs ADMIN. The 403 names the offending fields. Unauthenticated calls to gated routes return
**401**, not 403: authentication is checked before authorisation.

Demo accounts (shared `DEMO_USER_PASSWORD`): `admin@meridian.org` (ADMIN),
`f.alrashid@meridian.org` (ANALYST), `a.patel@meridian.org` (VIEWER).

---

## Pagination

| Parameter | Default | Max |
|---|---|---|
| `page` | 1 | — |
| `pageSize` | 25 | 200 (capped, not rejected) |

`totalPages` is never below 1. Applies to: assets, vendors, identities, access,
threats, controls, policies, remediations, risks, risk history, data flows,
audit, and every `/:id/history` route.

---

## Errors

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/param/query failed the schema. Includes `details[]`. |
| `BAD_REQUEST` | 400 | No file uploaded, or a non-`.csv` filename. |
| `MALFORMED_JSON` | 400 | Body is not valid JSON. |
| `IMPORT_VALIDATION_FAILED` | 400 | CSV rows failed. Includes `report`. Nothing written. |
| `UNAUTHORIZED` | 401 | No token, invalid/expired token, or replayed refresh token. |
| `FORBIDDEN` | 403 | Role not permitted, or account has no membership. |
| `NOT_FOUND` | 404 | Record absent **or in another organisation**. |
| `ROUTE_NOT_FOUND` | 404 | No route matches. |
| `CONFLICT` | 409 | Duplicate name, illegal transition, already archived, vendor still connected. |
| `PAYLOAD_TOO_LARGE` | 413 | JSON body over 100 KB. |
| `FILE_TOO_LARGE` | 413 | CSV over 2 MB. |
| `UNSUPPORTED_ENCODING` | 415 | Unsupported content encoding. |
| `RATE_LIMITED` | 429 | 300 req/15 min globally; 10 **failed** logins/15 min. |
| `INTERNAL_ERROR` | 500 | Unhandled. Message is always generic. |

409 messages name the legal alternatives where one exists, e.g.
`"Cannot move a threat from RESOLVED to INVESTIGATING. Allowed: OPEN"`.

---

## Enumerations

| Field | Values |
|---|---|
| Asset `type` | `EHR`, `DATABASE`, `API`, `CLOUD_STORAGE`, `ANALYTICS`, `OTHER` |
| PHI `sensitivity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| Vendor `baaStatus` | `SIGNED`, `PENDING`, `EXPIRED`, `MISSING` |
| Access `level` | `READ`, `WRITE`, `ADMIN` |
| Identity `kind` | `USER`, `SERVICE_ACCOUNT` |
| Threat `severity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| Threat `status` | `OPEN`, `INVESTIGATING`, `RESOLVED`, `FALSE_POSITIVE` |
| Risk `band` | `LOW`, `MODERATE`, `HIGH`, `CRITICAL`, `EXTREME` |
| Risk change `reason` | `INITIAL_ASSESSMENT`, `MANUAL_ASSESSMENT`, `RECOMPUTE`, `IMPORTED`, `ASSET_CHANGED`, `PHI_CHANGED`, `ACCESS_CHANGED`, `VENDOR_ACCESS_CHANGED`, `CONTROL_CHANGED`, `THREAT_CHANGED` |
| Risk `subjectType` | `ASSET`, `VENDOR` |
| Flow `status` | `ok`, `warn`, `violation` *(lowercase — the one exception)* |
| Access `flags[]` | `STALE`, `NEVER_USED`, `NO_MFA`, `INACTIVE_IDENTITY`, `EXCESSIVE_LEVEL` |
| Control `category` | `ACCESS`, `ENCRYPTION`, `MONITORING`, `GOVERNANCE`, `RESILIENCE`, `VENDOR` |
| Control `status` | `IMPLEMENTED`, `PARTIAL`, `PLANNED`, `NOT_IMPLEMENTED` |
| Control `effectiveness` | `EFFECTIVE`, `PARTIALLY_EFFECTIVE`, `INEFFECTIVE`, `NOT_ASSESSED` |
| Policy `status` | `DRAFT`, `ACTIVE`, `UNDER_REVIEW`, `ARCHIVED` |
| Remediation `status` | `OPEN`, `IN_PROGRESS`, `RESOLVED`, `ACCEPTED`, `REOPENED` |
| Remediation `severity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| Finding `source` | `RISK`, `THREAT`, `ACCESS`, `VENDOR`, `CONTROL`, `MANUAL` |

### The risk formula — unchanged

```
score = (likelihood × impact × exposure × controlGap) / 625 × 100    (2 dp)
```

Each input is an integer 1–5. Bands are upper bounds on the 0–100 score:
`≤20 LOW`, `≤40 MODERATE`, `≤60 HIGH`, `≤80 CRITICAL`, else `EXTREME`. The
curve is steep because it is a product of four factors: 4/4/4/3 scores 30.72.

### Where the four factors come from

| Factor | Source |
|---|---|
| `likelihood` | **Assessor judgement.** Only ever set by an assessment. |
| `impact` | **Assessor judgement.** Only ever set by an assessment. |
| `exposure` | **Derived** from PHI volume, encryption, MFA, live grants and their levels, vendor reach, unencrypted outbound flows, and open HIGH/CRITICAL threats. |
| `controlGap` | **Derived** from applied controls that are IMPLEMENTED+EFFECTIVE (weight 1.0) or PARTIAL/PARTIALLY_EFFECTIVE (0.5). |

The two derived factors are recomputed automatically whenever a mutation
changes one of their inputs. Supplying either in an assessment **pins** it —
`exposureOverridden` / `controlGapOverridden` go true and the derivation leaves
that factor alone until a later assessment omits it. Assessor judgement
outranks the derivation, always.

Every derived value ships with a `derivation` string naming the facts behind
it. There is no model, no fitted weighting, and no free-text narrative: the
thresholds are constants in `src/services/riskFactors.ts`.

### Automatic recomputation

These mutations trigger a rescore of the affected subject(s):

| Mutation | Reason recorded | Subjects rescored |
|---|---|---|
| Asset `phiVolume` / `encrypted` / `mfaEnabled` changed | `ASSET_CHANGED` | that asset |
| Access granted, re-levelled or revoked | `ACCESS_CHANGED` | that asset |
| Identity archived (revokes every grant) | `ACCESS_CHANGED` | every asset it could reach |
| Vendor↔asset link added or removed | `VENDOR_ACCESS_CHANGED` | the vendor and its assets |
| Vendor `baaStatus` / `lastAssessedAt` changed | `VENDOR_ACCESS_CHANGED` | that vendor |
| Control applied to / removed from an asset | `CONTROL_CHANGED` | that asset |
| Control `status` / `effectiveness` changed | `CONTROL_CHANGED` | every asset it is applied to |
| Threat created, or transitioned in/out of open HIGH/CRITICAL | `THREAT_CHANGED` | that asset |
| Risk CSV imported | `IMPORTED` | the imported assets |

Three guarantees, each covered by tests:

- **No loop.** Recalculation reads the graph and writes only Risk, RiskHistory
  and AuditEvent — never an asset, vendor, grant, control or threat.
- **No noise.** A recalculation that changes nothing writes no history row, and
  mutations that cannot move a score (renaming an asset) do not fire at all.
- **No invented assessments.** An unassessed subject stays unassessed no matter
  what changes around it.

Mutations that trigger a rescore return `riskChanged` alongside the updated
record — the new snapshot, or `null`. Vendor-link routes return an array,
because both sides can move.

### Flow status

Unencrypted in transit → `violation`. Encrypted but landing on an asset without
MFA → `warn`. Encrypted into an MFA-protected asset → `ok`. MFA is read from
the **target** asset.

---

# Endpoints

## Health

### `GET /health`

Public liveness probe, outside `/api` so the auth gate never applies.

```bash
curl -s http://localhost:4000/health
```

```json
{ "status": "ok", "service": "drishti-api", "version": "0.3.0" }
```

> Use `/health`. `/api/health` does not exist and returns 401 from the auth gate.

---

## Auth

| Method | Path | Auth |
|---|---|---|
| POST | `/api/auth/login` | public (rate limited) |
| POST | `/api/auth/refresh` | public (requires a refresh token) |
| POST | `/api/auth/logout` | public |
| POST | `/api/auth/logout-all` | authenticated |
| GET | `/api/auth/me` | authenticated |

### `POST /api/auth/login`

| Field | Type | Required | Rules |
|---|---|---|---|
| `email` | string | yes | valid email |
| `password` | string | yes | non-empty |
| `organizationId` | number | no | must be one of the account's memberships |

**200** — also sets both cookies.

```json
{
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 3600,
    "refreshToken": "9f2c...",
    "refreshExpiresIn": 2592000,
    "user": { "id": 1, "email": "admin@meridian.org", "role": "ADMIN", "organizationId": 1 },
    "memberships": [
      { "organizationId": 1, "organizationName": "Meridian Health System",
        "organizationSlug": "meridian", "role": "ADMIN" }
    ]
  }
}
```

**Errors.** `401` — `"Invalid email or password"`, identical for an unknown
address and a wrong password so the endpoint cannot enumerate accounts. `403` —
the account exists but belongs to no organisation, or not to the one requested.
`429` after 10 failures in 15 minutes (successes are not counted).

```bash
curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"<DEMO_USER_PASSWORD>"}'
```

### `POST /api/auth/refresh`

Reads the refresh token from the `drishti_refresh` cookie, or `{ refreshToken }`
in the body. Returns the same shape as login and rotates both tokens.

**401** if unknown, expired, or **already used**. The last case revokes every
session for that user — treat it as "sign in again", not a retryable error.
**403** if membership was withdrawn since the token was issued.

```bash
curl -s -X POST http://localhost:4000/api/auth/refresh \
  -H 'Content-Type: application/json' -d '{"refreshToken":"<refreshToken>"}'
```

### `POST /api/auth/logout` · `POST /api/auth/logout-all`

Logout revokes the presented refresh token and clears all three cookies
(including the legacy name). `logout-all` requires a valid access token and
revokes every live refresh token for the account.

```json
{ "data": { "ok": true, "revokedSessions": 2 } }
```

### `GET /api/auth/me`

```json
{
  "data": {
    "id": 1, "email": "admin@meridian.org", "role": "ADMIN", "organizationId": 1,
    "organization": { "id": 1, "name": "Meridian Health System", "slug": "meridian" },
    "memberships": [ { "organizationId": 1, "organizationName": "...", "role": "ADMIN" } ]
  }
}
```

---

## Organization

| Method | Path | Role |
|---|---|---|
| GET | `/api/organization` | any |
| GET | `/api/organization/members` | any |

Reads `organizationId` from the session; there is no `:id` form, because an
endpoint that let a caller name the organisation would be the tenant boundary's
one hole.

```bash
curl -s http://localhost:4000/api/organization -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "id": 1, "name": "Meridian Health System", "slug": "meridian",
    "createdAt": "2026-09-22T22:18:14.018Z",
    "counts": { "members": 3, "assets": 16, "vendors": 5, "identities": 6,
                "threats": 5, "controls": 0, "policies": 0, "remediations": 0 },
    "yourRole": "ADMIN"
  }
}
```

`/members` returns `[{ userId, email, role, memberSince }]` — the list a
remediation owner picker needs.

---

## Assets

| Method | Path | Role |
|---|---|---|
| GET | `/api/assets` | any |
| POST | `/api/assets` | ADMIN, ANALYST |
| GET | `/api/assets/:id` | any |
| PATCH | `/api/assets/:id` | ADMIN, ANALYST |
| POST | `/api/assets/:id/archive` | ADMIN |
| POST | `/api/assets/:id/restore` | ADMIN |
| POST | `/api/assets/:id/assessment` | ADMIN, ANALYST |
| POST | `/api/assets/:id/recompute` | ADMIN, ANALYST |
| GET | `/api/assets/:id/risk-history` | any |
| GET | `/api/assets/:id/history` | any |
| GET | `/api/assets/:id/control-evidence` | any |
| PUT | `/api/assets/:id/controls/:controlId` | ADMIN, ANALYST |
| DELETE | `/api/assets/:id/controls/:controlId` | ADMIN, ANALYST |

**Query:** `page`, `pageSize`, `search`, `type`, `band`, `includeArchived`,
`sort` (`name` | `phiVolume` | `riskScore` | `createdAt`), `order`.

**List row:**

```json
{
  "id": 6, "name": "Billing Engine DB", "type": "DATABASE",
  "phiVolume": 87100, "encrypted": false, "mfaEnabled": false,
  "lastAssessedAt": "2026-06-26T09:58:44.299Z",
  "createdAt": "2026-09-22T09:58:44.299Z", "archivedAt": null,
  "risk": { "score": 100, "band": "EXTREME", "computedAt": "2026-09-22T09:58:44.319Z" },
  "counts": { "phiTypes": 1, "flows": 2, "accessGrants": 2, "openThreats": 1, "controls": 0 }
}
```

`risk` is `null` for a never-assessed asset, and such assets are absent from
`/api/risks` entirely. `sort=riskScore` places them **last in both
directions** — no score is not a low score.

**Detail** adds the full graph in one call: `phiTypes[]`, `risk` with all four
1–5 factors, `flows.outbound[]`/`flows.inbound[]`, `vendors[]`, `access[]`,
`threats[]`, `controls[]`, `remediations[]`.

**Create body:** `name` (1–120, unique per org), `type` (enum), plus optional
`phiVolume` (int ≥0), `encrypted`, `mfaEnabled`, `lastAssessedAt`.
**PATCH** takes any subset but rejects `{}` with
`"Provide at least one field to update"`.

```bash
curl -s -X POST http://localhost:4000/api/assets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Radiology PACS","type":"CLOUD_STORAGE","phiVolume":48200,"encrypted":true}'
```

### `POST /api/assets/:id/assessment`

The path that records an assessor's judgement. **201** on first assessment,
**200** thereafter.

```bash
curl -s -X POST http://localhost:4000/api/assets/3/assessment \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"likelihood":4,"impact":5,"exposure":4,"controlGap":3}'
```

```json
{
  "data": {
    "id": 5, "assetId": 3, "assetName": "Epic EHR Core",
    "likelihood": 4, "impact": 5, "exposure": 4, "controlGap": 3,
    "score": 38.4, "band": "MODERATE",
    "computedAt": "2026-09-22T10:14:00.000Z",
    "previous": { "score": 8.64, "band": "LOW" },
    "changed": true
  }
}
```

Each input must be an integer 1–5; outside that is a 400.

### `POST /api/assets/:id/recompute`

Re-scores from the **stored** inputs. Still 404s when the asset has never been
assessed — recompute derives from judgement and has none to derive from.
A recompute that changes nothing writes no history row.

### `GET /api/assets/:id/risk-history`

Paginated, newest first. `delta` is precomputed so the chart and the
"65 → 72" label agree.

```json
{ "data": [ { "id": 12, "assetId": 3, "assetName": "Epic EHR Core",
    "previousScore": 8.64, "previousBand": "LOW", "score": 38.4, "band": "MODERATE",
    "delta": 29.76, "likelihood": 4, "impact": 5, "exposure": 4, "controlGap": 3,
    "reason": "MANUAL_ASSESSMENT",
    "changedBy": { "id": 1, "email": "admin@meridian.org" },
    "changedAt": "2026-09-22T10:14:00.000Z" } ],
  "meta": { "page": 1, "pageSize": 25, "total": 1, "totalPages": 1 } }
```

There is no free-text explanation field. `reason` is an enum of things the
system observed; compose narrative client-side from it plus the factor deltas.

### `GET /api/assets/:id/control-evidence`

```json
{ "data": { "assetId": 3, "appliedControls": 4, "effectiveControls": 2,
    "partialControls": 1, "weightedCoverage": 2.5, "suggestedControlGap": 3,
    "applied": false,
    "basis": "Weighted count of applied controls that are IMPLEMENTED and EFFECTIVE (1.0) or PARTIAL/PARTIALLY_EFFECTIVE (0.5).",
    "controls": [ { "id": 2, "name": "Encryption at Rest", "category": "ENCRYPTION",
                    "status": "IMPLEMENTED", "effectiveness": "EFFECTIVE" } ] } }
```

`applied` is always `false`: this is a suggestion. To act on it, POST it as an
assessment. Risk never moves because a control checkbox changed.

---

## Risks

| Method | Path | Role |
|---|---|---|
| GET | `/api/risks` | any |
| GET | `/api/risks/distribution` | any |
| GET | `/api/risks/history` | any |
| POST | `/api/risks/:assetId/recompute` | ADMIN, ANALYST — **deprecated** |

```bash
curl -s http://localhost:4000/api/risks/distribution -H "Authorization: Bearer $TOKEN"
```

```json
{ "data": { "LOW": 2, "MODERATE": 3, "HIGH": 1, "CRITICAL": 1, "EXTREME": 1 } }
```

`/api/risks` rows carry `assetId`, `assetName`, `assetType`, `assetArchived`,
the four factors, `score`, `band`, `computedAt`. Ordered by score descending.

The `:assetId/recompute` alias behaves identically to
`POST /api/assets/:id/recompute` and is retained for existing clients.

---

## Data flows

| Method | Path | Role |
|---|---|---|
| GET | `/api/dataflows` | any |
| GET | `/api/dataflows/:id` | any |

**Query:** `page`, `pageSize`, `status` (`ok`/`warn`/`violation`), `assetId`.

```json
{ "id": 5, "source": "Epic EHR Core", "sourceAssetId": 3,
  "target": "Billing Engine DB", "targetAssetId": 6,
  "phiType": "Financial", "phiTypeId": 2, "sensitivity": "MEDIUM",
  "recordsPerDay": 87100, "encrypted": false, "status": "violation" }
```

Ordered by `recordsPerDay` descending. `status` is derived, so filtering on it
is applied after the fetch and pagination then applies to the filtered set —
`meta.total` stays truthful either way.

---

## Vendors

| Method | Path | Role |
|---|---|---|
| GET | `/api/vendors` · `/api/vendors/:id` | any |
| POST | `/api/vendors` | ADMIN, ANALYST |
| PATCH | `/api/vendors/:id` | ADMIN, ANALYST |
| POST | `/api/vendors/:id/assessment` | ADMIN, ANALYST |
| POST | `/api/vendors/:id/recompute` | ADMIN, ANALYST |
| POST | `/api/vendors/:id/archive` · `/restore` | ADMIN |
| PUT/DELETE | `/api/vendors/:id/assets/:assetId` | ADMIN, ANALYST |
| GET | `/api/vendors/:id/history` | any |

**Create body:** `name` (unique per org), optional `baaStatus`, `phiVolume`,
`lastAssessedAt`.

List rows carry `daysSinceAssessment`, `assessmentOverdue` (>365 days or
never), `baaCompliant`, `assetCount`, `assets[]` (names), `openRemediations`
and `risk`. Detail replaces `assets[]` with objects and adds `phiExposure` —
the total PHI reachable through them — plus the four risk factors.

**Archiving a vendor that still has asset access returns 409.** Remove the
access first; that is the action that actually reduces exposure.

```bash
curl -s -X PUT http://localhost:4000/api/vendors/1/assets/6 \
  -H "Authorization: Bearer $TOKEN"
```

---

## Identities

| Method | Path | Role |
|---|---|---|
| GET | `/api/identities` · `/api/identities/:id` | any |
| POST | `/api/identities` | ADMIN, ANALYST |
| PATCH | `/api/identities/:id` | ADMIN, ANALYST |
| POST | `/api/identities/:id/archive` | ADMIN |

**Query:** `search`, `kind`, `active`, `includeArchived`.

**Create body:** `displayName` (unique per org), optional `email` (unique per
org), `kind`, `department`, `role`, `active`, `mfaEnabled`.

Detail adds `grants[]` and `phiReach` — total PHI the identity can currently
reach.

### `POST /api/identities/:id/archive`

Archives the identity **and revokes every one of its grants, in one
transaction**. Deactivating a leaver without removing their access is the exact
failure this product exists to surface, so the two are not separable here.

```json
{ "data": { "identity": { "id": 4, "archivedAt": "...", "active": false },
            "revokedGrants": 2 } }
```

Grants are revoked, not deleted — the review trail survives.

---

## Access

| Method | Path | Role |
|---|---|---|
| GET | `/api/access` | any |
| GET | `/api/access/summary` | any |
| GET | `/api/access/:id` | any |
| POST | `/api/access` | ADMIN, ANALYST |
| PATCH | `/api/access/:id` | ADMIN, ANALYST |
| POST | `/api/access/:id/revoke` | ADMIN, ANALYST |
| POST | `/api/access/:id/review` | ADMIN, ANALYST |

**Query:** `assetId`, `identityId`, `level`, `flaggedOnly`, `includeRevoked`,
`search`.

Rows carry identity and asset detail, `grantedAt`, `lastUsedAt`,
`lastReviewedAt`, `revokedAt`, `daysSinceUse`, `daysSinceGrant`, `flags[]` and
`riskFlagCount`. Ordered worst-first by flag count, then longest idle.

| Flag | Raised when |
|---|---|
| `NEVER_USED` | `lastUsedAt` is null |
| `STALE` | used, but more than 90 days ago |
| `INACTIVE_IDENTITY` | the identity is deactivated |
| `NO_MFA` | identity is a `USER` (not a service account) without MFA |
| `EXCESSIVE_LEVEL` | non-`READ` on an asset holding more than 50,000 PHI records |

"Never reviewed" is deliberately **not** a flag — it would fire on every row of
a fresh estate and `riskFlagCount` is what the list sorts by. Use
`lastReviewedAt` per row, and `neverReviewed` in the summary.

```bash
curl -s http://localhost:4000/api/access/summary -H "Authorization: Bearer $TOKEN"
```

```json
{ "data": { "total": 9, "flagged": 6, "stale": 1, "neverUsed": 1,
            "withoutMfa": 3, "inactiveIdentities": 1, "excessiveLevel": 6,
            "neverReviewed": 9, "staleAfterDays": 90 } }
```

`POST /api/access` takes `{ identityId, assetId, level?, grantedAt?, lastUsedAt? }`.
Re-granting a previously revoked pair reactivates that row rather than creating
a second — the constraint is on `(identityId, assetId)` and the grant's history
is worth keeping attached. A live duplicate is a 409.

`revoke` sets `revokedAt` and records who did it. **There is no DELETE.**

---

## Threats

| Method | Path | Role |
|---|---|---|
| GET | `/api/threats` · `/api/threats/summary` · `/api/threats/:id` | any |
| POST | `/api/threats` | ADMIN, ANALYST |
| PATCH | `/api/threats/:id` | ADMIN, ANALYST |
| POST | `/api/threats/:id/status` | ADMIN, ANALYST |
| GET | `/api/threats/:id/history` | any |

**Query:** `status`, `severity`, `assetId`, `openOnly`, `search`.

```bash
curl -s http://localhost:4000/api/threats/summary -H "Authorization: Bearer $TOKEN"
```

```json
{ "data": { "total": 5, "open": 3,
    "bySeverity": { "LOW": 1, "MEDIUM": 1, "HIGH": 1, "CRITICAL": 2 },
    "byStatus": { "OPEN": 2, "INVESTIGATING": 1, "RESOLVED": 1, "FALSE_POSITIVE": 1 },
    "openCritical": 2 } }
```

**Create body:** `assetId`, `severity`, `title` (unique per asset),
`description`, optional `status`, `detectedAt`.

### `POST /api/threats/:id/status`

Body `{ "status": "INVESTIGATING" }`. Legal transitions:

| From | To |
|---|---|
| `OPEN` | `INVESTIGATING`, `RESOLVED`, `FALSE_POSITIVE` |
| `INVESTIGATING` | `OPEN`, `RESOLVED`, `FALSE_POSITIVE` |
| `RESOLVED` | `OPEN` |
| `FALSE_POSITIVE` | `OPEN` |

Closing stamps `resolvedAt`; reopening clears it. Illegal moves and no-ops
return 409 naming the legal set. The detail response carries
`allowedTransitions[]` so a UI can render exactly the right buttons.

---

## Controls

| Method | Path | Role |
|---|---|---|
| GET | `/api/controls` · `/api/controls/:id` | any |
| POST | `/api/controls` | ADMIN, ANALYST |
| PATCH | `/api/controls/:id` | ADMIN, ANALYST |
| POST | `/api/controls/:id/archive` | ADMIN |
| PUT/DELETE | `/api/controls/:id/assets/:assetId` | ADMIN, ANALYST |

**Create body:** `name` (unique per org), `description`, `category`, optional
`status`, `effectiveness`, `owner`, `frameworkRef`, `lastReviewedAt`.

List rows add `appliedAssetCount`, `policyCount`, `openRemediations`. Detail
adds `assets[]`, `policies[]`, `remediations[]` and `phiCovered`.

> `frameworkRef` is free text the customer typed (e.g. `"HIPAA 164.312(a)(1)"`).
> Drishti stores it as a reference and **asserts no conformance with any
> framework** on the strength of it. Render it as a citation, never as a
> compliance claim.

```bash
curl -s -X POST http://localhost:4000/api/controls \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Multi-Factor Authentication","description":"MFA on all PHI systems","category":"ACCESS","status":"PARTIAL","effectiveness":"PARTIALLY_EFFECTIVE"}'
```

---

## Policies

| Method | Path | Role |
|---|---|---|
| GET | `/api/policies` · `/api/policies/:id` | any |
| POST | `/api/policies` | ADMIN, ANALYST |
| PATCH | `/api/policies/:id` | ADMIN, ANALYST |
| POST | `/api/policies/:id/archive` | ADMIN |
| PUT/DELETE | `/api/policies/:id/controls/:controlId` | ADMIN, ANALYST |

**Create body:** `name` (unique per org), `description`, optional `status`,
`owner`, `evidenceRef`, `reviewDueAt`.

Rows carry `controlCount` and `reviewOverdue`. Detail lists the linked
controls. `evidenceRef` is a customer-supplied pointer; its contents are never
inspected or asserted about.

---

## Remediation

| Method | Path | Role |
|---|---|---|
| GET | `/api/remediations` · `/summary` · `/:id` · `/:id/history` | any |
| POST | `/api/remediations` | ADMIN, ANALYST |
| PATCH | `/api/remediations/:id` | ADMIN, ANALYST |
| POST | `/api/remediations/:id/status` | ADMIN, ANALYST |
| POST | `/api/remediations/:id/assign` | ADMIN, ANALYST |

**Query:** `status`, `severity`, `source`, `ownerId`, `assetId`, `vendorId`,
`openOnly`, `overdueOnly`, `search`.

**Create body:** `title`, `description`, `recommendation`, optional `severity`,
`source`, `ownerId`, `dueAt`, and any of `assetId`, `vendorId`, `threatId`,
`controlId`, `identityId`, `accessGrantId`. **Every link is verified to belong
to the caller's organisation** — a foreign id is a 404, not a stored row.
`ownerId` must be a member of the organisation.

```bash
curl -s -X POST http://localhost:4000/api/remediations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Billing DB stores PHI unencrypted","description":"87,100 records at rest without encryption.","recommendation":"Enable AES-256 and re-key during the next window.","severity":"CRITICAL","source":"RISK","assetId":6}'
```

Rows carry `open`, `overdue`, `owner`, and a `subject` object naming whichever
entity the finding points at.

### `POST /api/remediations/:id/status`

| From | To |
|---|---|
| `OPEN`, `IN_PROGRESS`, `REOPENED` | `RESOLVED`, `ACCEPTED` (and between themselves) |
| `RESOLVED`, `ACCEPTED` | `REOPENED` |

`ACCEPTED` means risk accepted without fixing, and stays distinct from
`RESOLVED` in every count.

> **Resolving does not change the estate.** It persists a status, a timestamp,
> an actor and an audit event — a claim about people. It does not touch the
> asset, control or threat the finding points at. If the UI needs to say the
> estate changed, the estate has to change: PATCH the asset or record an
> assessment.

---

## Audit

| Method | Path | Role |
|---|---|---|
| GET | `/api/audit` | **ADMIN** |
| GET | `/api/{assets,vendors,threats,remediations}/:id/history` | any |

**Query:** `action`, `entityType`, `entityId`, `actorUserId`, `from`, `to`,
plus pagination. Newest first.

```json
{ "data": [ { "id": 41, "action": "ASSET_UPDATED",
    "actor": { "id": 1, "email": "admin@meridian.org" },
    "entityType": "Asset", "entityId": 6, "result": "SUCCESS",
    "metadata": { "changes": { "encrypted": { "from": false, "to": true } } },
    "ip": "::1", "createdAt": "2026-09-22T10:20:00.000Z" } ],
  "meta": { "page": 1, "pageSize": 25, "total": 1, "totalPages": 1 } }
```

43 action types covering authentication, every CRUD path, risk changes, threat
and remediation transitions, access grants and revocations, and imports.

**Read-only.** There is no POST, PATCH or DELETE, and the only writer in the
codebase is `auditService.ts`. Credentials and patient identifiers are stripped
from `metadata` before storage.

---

## Search

### `GET /api/search`

| Parameter | Notes |
|---|---|
| `q` | required, 2–120 chars |
| `types` | optional, comma-separated subset |
| `limit` | optional, max 50 |

```bash
curl -s "http://localhost:4000/api/search?q=Epic&limit=2" -H "Authorization: Bearer $TOKEN"
```

```json
{ "data": { "query": "Epic", "truncated": false,
    "results": [ { "type": "asset", "id": 3, "title": "Epic EHR Core",
                   "status": "HIGH", "context": "EHR · 412,000 PHI records" } ] } }
```

Searchable types: `asset`, `vendor`, `identity`, `threat`, `remediation`,
`control`, `policy`. Bounded by construction — 10 per type, 50 overall,
2-character minimum, archived records excluded. There is no "search everything"
mode: an unbounded cross-table scan is a denial-of-service primitive handed to
any authenticated user.

---

## Reports

### `GET /api/reports/risk-assessment`

Structured JSON, every figure counted from persisted rows at request time.

Sections: `organization`, `generatedAt`, `assets` (total / archived / assessed /
unassessed / `assessmentCoverage`), `phi`, `flows`, `riskDistribution`,
`topRisks[]`, `vendors`, `access`, `controls`, `threats`, `remediation`,
`disclaimer`.

> **There is no compliance score.** The percentages are coverage ratios over
> recorded data — how much of the estate has been assessed, how many controls
> are both implemented and assessed effective. The payload carries a
> `disclaimer` string stating this; render it wherever the numbers appear.

---

## Import

Unchanged in behaviour from v0.1 apart from tenant scoping, auditing and the
template filename. Full narrative in [`IMPORT_GUIDE.md`](./IMPORT_GUIDE.md).

| Method | Path | Role |
|---|---|---|
| GET | `/api/import` | ADMIN |
| GET | `/api/import/:entity/template` | ADMIN |
| POST | `/api/import/:entity/validate` | ADMIN |
| POST | `/api/import/:entity` | ADMIN |

Seven entities: `assets`, `phi-types`, `data-flows`, `vendors`,
`access-grants`, `threats`, `risks`. Upload as `multipart/form-data`, field
`file`, `.csv` only, 2 MB maximum, held in memory and never written to disk.

`validate` is a dry run returning 200 with `valid: true|false`. The real import
is all-or-nothing inside one transaction: 201 with `imported: n`, or 400
`IMPORT_VALIDATION_FAILED` carrying the full report with nothing written.

CSV formula injection is refused on the way in and escaped on the way out.
Templates download as `drishti-<entity>-template.csv`.

Imports write `IMPORT_STARTED`, then `IMPORT_COMPLETED` or `IMPORT_FAILED`.
Imported risk rows gain history with `reason: "IMPORTED"`.

```bash
curl -s -X POST http://localhost:4000/api/import/assets/validate \
  -H "Authorization: Bearer $TOKEN" -F "file=@assets.csv"
```

---

## Derived fields

Computed per request, never stored. Do not try to write them.

| Field | Where | Rule |
|---|---|---|
| `daysSinceAssessment`, `assessmentOverdue` | vendors | overdue if never assessed or >365 days |
| `baaCompliant` | vendors | `baaStatus === "SIGNED"` |
| `phiExposure` | vendor detail | sum of reachable asset `phiVolume` |
| `phiReach` | identity detail | sum of `phiVolume` over live grants |
| `phiCovered` | control detail | sum of `phiVolume` over applied assets |
| `daysSinceUse`, `daysSinceGrant`, `flags[]`, `riskFlagCount` | access | see the flag table |
| `hoursSinceDetection`, `open` | threats | `open` = `OPEN` or `INVESTIGATING` |
| `overdue`, `open` | remediation | `overdue` = open and `dueAt` in the past |
| `reviewOverdue` | policies | `reviewDueAt` in the past |
| `status` | data flows | see [flow status](#flow-status) |
| `delta` | risk history | `score − previousScore`, 2 dp |
| `assessmentCoverage`, `effectiveRate` | reports | coverage ratios, not scores |
| `allowedTransitions[]` | threat / remediation detail | the legal next states |

---

## Known limits

Scope decisions, not defects.

- **No DELETE on any customer record.** Assets, vendors, identities, controls
  and policies archive; access grants revoke. The compliance record is the
  product.
- **No compliance score**, and none is planned — it cannot be computed honestly.
- **No AI endpoints.** None exist, and none return canned text.
- **No notifications.** Derive banners from `overdueOnly`, `openOnly`,
  `assessmentOverdue`, `reviewOverdue`.
- **No organisation-switch endpoint.** Log in again with `organizationId`.
- **No signup, password reset or MFA on API login.** Accounts are seeded.
- **No vendor risk history.** Asset risk history exists; the vendor equivalent
  does not yet.
- **No PHI-type REST endpoints.** Import only.
- **No free-text risk-change explanations.** `reason` enum plus factor deltas.
- **Cursor pagination is not offered** — offset only, which is what a
  page-numbered table needs.
