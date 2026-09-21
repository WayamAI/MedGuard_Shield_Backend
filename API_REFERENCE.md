# MedGuard API Reference

Complete reference for the MedGuard PHI risk-intelligence API. Every endpoint below
was executed against a running server during the verification sweep of 2026-09-21; the
status codes and response bodies shown are observed, not illustrative.

- **Base URL (demo):** `http://localhost:4000`
- **Content type:** JSON everywhere except CSV upload (`multipart/form-data`) and
  template download (`text/csv`).
- **22 endpoints**, grouped below by area.

---

## Contents

1. [Conventions](#conventions)
2. [Authentication](#authentication)
3. [Roles](#roles)
4. [Errors](#errors)
5. [Enumerations](#enumerations)
6. [Endpoints](#endpoints)
   - [Health](#health)
   - [Auth](#auth)
   - [Assets](#assets)
   - [Data flows](#data-flows)
   - [Risks](#risks)
   - [Vendors](#vendors)
   - [Access](#access)
   - [Threats](#threats)
   - [Import](#import)
7. [Import CSV contracts](#import-csv-contracts)
8. [Known limits](#known-limits)

---

## Conventions

**Success envelope.** Every successful JSON response is wrapped in a single `data` key:

```json
{ "data": ... }
```

`data` is an array for list endpoints (`/api/assets`, `/api/dataflows`, `/api/risks`,
`/api/vendors`), and an object for single-record endpoints. Two endpoints —
`/api/access` and `/api/threats` — return an **object containing a summary plus a list**,
not a bare array. See their sections.

**Failure envelope.** Every error is:

```json
{ "error": { "code": "STRING_CODE", "message": "Human-readable sentence" } }
```

Validation failures add a `details` array. Failed imports add a `report` object.
Stack traces are never returned to the caller.

**Dates** are ISO 8601 UTC strings (`"2026-09-05T19:45:49.359Z"`) on the way out. On the
way in, both request bodies and CSV cells accept `YYYY-MM-DD`.

**Getting a token for the examples.** Every `curl` below assumes `$TOKEN`:

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"<DEMO_USER_PASSWORD>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')
```

The demo password is the `DEMO_USER_PASSWORD` value in `.env`.

---

## Authentication

All routes under `/api` require a valid session **except** `/api/auth/login` and
`/api/auth/logout`. `/health` sits outside `/api` entirely and is always public.

A token is accepted two ways (`src/middleware/auth.ts`):

| Method | Header |
|---|---|
| Bearer header | `Authorization: Bearer <token>` |
| Cookie | `Cookie: medguard_token=<token>` |

`POST /api/auth/login` sets the cookie (`httpOnly`, `sameSite=lax`, not `secure` because
the demo runs over plain HTTP) **and** returns the token in the body, so browser and
fetch clients both work without special handling.

Tokens are stateless JWTs with an **8-hour TTL** (`expiresIn: 28800`). There is no
refresh endpoint and no server-side revocation — `POST /api/auth/logout` clears the
cookie, and a token already held stays valid until it expires.

Missing token → `401 UNAUTHORIZED` (`"Authentication required"`).
Invalid or expired token → `401 UNAUTHORIZED` (`"Invalid or expired session token"`).

---

## Roles

Three roles, carried in the JWT and returned by `GET /api/auth/me`.

| Role | Can read | Can write assets/vendors/risks | Can import |
|---|---|---|---|
| `VIEWER` | ✅ | ❌ `403` | ❌ `403` |
| `ANALYST` | ✅ | ✅ | ❌ `403` |
| `ADMIN` | ✅ | ✅ | ✅ |

Import is deliberately narrower than ordinary writes: it writes straight into the PHI
inventory, so all four `/api/import` endpoints — including the read-only template and
contract endpoints — are ADMIN-only.

A role failure returns `403 FORBIDDEN` with the required roles named, e.g.
`"Requires one of: ADMIN, ANALYST"`. Note that an **unauthenticated** call to a
role-gated route returns `401`, not `403` — authentication is checked first.

Demo accounts (all share `DEMO_USER_PASSWORD`):

| Email | Role |
|---|---|
| `admin@meridian.org` | ADMIN |
| `f.alrashid@meridian.org` | ANALYST |
| `a.patel@meridian.org` | VIEWER |

---

## Errors

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body or path parameter failed schema validation. Includes `details[]`. |
| `BAD_REQUEST` | 400 | Upload-level problem: no file, or a non-`.csv` filename. |
| `MALFORMED_JSON` | 400 | Request body is not parseable JSON. |
| `IMPORT_VALIDATION_FAILED` | 400 | CSV parsed but contains row errors. Includes full `report`. Nothing was written. |
| `UNAUTHORIZED` | 401 | No token, or an invalid/expired one. |
| `FORBIDDEN` | 403 | Authenticated but the role is not permitted. |
| `NOT_FOUND` | 404 | Record, or unknown import entity, does not exist. |
| `ROUTE_NOT_FOUND` | 404 | No route matches the method and path. |
| `CONFLICT` | 409 | Unique-name collision on create. |
| `PAYLOAD_TOO_LARGE` | 413 | JSON request body exceeds the parser limit. |
| `FILE_TOO_LARGE` | 413 | Uploaded CSV exceeds 2 MB. |
| `UNSUPPORTED_ENCODING` | 415 | Unsupported content encoding. |
| `RATE_LIMITED` | 429 | Rate limit tripped. See below. |
| `INTERNAL_ERROR` | 500 | Unhandled server error. Message is always generic. |

`VALIDATION_ERROR` detail shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "type", "message": "Invalid option: expected one of \"EHR\"|..." }]
  }
}
```

For a whole-object rule (e.g. an empty PATCH body), `path` is the empty string `""`.

**Rate limits** (`src/middleware/security.ts`):

| Scope | Window | Limit |
|---|---|---|
| All requests | 15 min | 300 |
| `POST /api/auth/login` | 15 min | 10 **failed** attempts (successes are not counted) |

Both return `429 RATE_LIMITED` and send `draft-7` standard rate-limit headers.

---

## Enumerations

| Field | Values |
|---|---|
| Asset `type` | `EHR`, `DATABASE`, `API`, `CLOUD_STORAGE`, `ANALYTICS`, `OTHER` |
| PHI type `sensitivity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| Vendor `baaStatus` | `SIGNED`, `PENDING`, `EXPIRED`, `MISSING` |
| Access grant `level` | `READ`, `WRITE`, `ADMIN` |
| Threat `severity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| Threat `status` | `OPEN`, `INVESTIGATING`, `RESOLVED`, `FALSE_POSITIVE` |
| Risk `band` | `LOW`, `MODERATE`, `HIGH`, `CRITICAL`, `EXTREME` |
| Data flow `status` | `ok`, `warn`, `violation` |
| Access grant `flags[]` | `STALE`, `NEVER_USED`, `NO_MFA`, `INACTIVE_IDENTITY`, `EXCESSIVE_LEVEL` |

**How risk scores are derived** (`src/services/riskScoring.ts`). Four assessor
judgements, each an integer 1–5, are multiplied and normalised:

```
score = (likelihood × impact × exposure × controlGap) / 625 × 100   (2 dp)
```

Bands are upper bounds on that 0–100 score: `≤20 LOW`, `≤40 MODERATE`, `≤60 HIGH`,
`≤80 CRITICAL`, else `EXTREME`. The curve is steep because it is a product of four
factors — 4/4/4/3 scores only 30.72 (MODERATE), and `EXTREME` effectively needs all 5s.

**How flow status is derived** (`src/services/flowStatus.ts`). Unencrypted in transit is
a `violation` outright. Encrypted but landing on an asset without MFA is a `warn`.
Encrypted into an MFA-protected asset is `ok`. MFA is read from the **target** asset.

---

# Endpoints

## Health

### `GET /health`

Liveness probe. Public — deliberately outside `/api` so the auth gate never applies.

**Auth:** none. **Response:** `200`

```json
{ "status": "ok" }
```

```bash
curl -s http://localhost:4000/health
```

---

## Auth

### `POST /api/auth/login`

**Auth:** public (login rate limiter applies).

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `email` | string | yes | Must be a valid email address |
| `password` | string | yes | Non-empty |

**Response `200`** — also sets the `medguard_token` cookie.

```json
{
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 28800,
    "user": { "id": 1, "email": "admin@meridian.org", "role": "ADMIN" }
  }
}
```

**Failures:** `401 UNAUTHORIZED` — `"Invalid email or password"`, returned identically
for an unknown address and a wrong password so the endpoint cannot be used to enumerate
accounts. `400 VALIDATION_ERROR` for a malformed body. `429 RATE_LIMITED` after 10
failures in 15 minutes.

```bash
curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridian.org","password":"<DEMO_USER_PASSWORD>"}'
```

### `POST /api/auth/logout`

**Auth:** public. Clears the cookie. Because JWTs are stateless, a token the client
already holds remains valid until it expires — this ends a *browser* session only.

**Response `200`:** `{ "data": { "ok": true } }`

```bash
curl -s -X POST http://localhost:4000/api/auth/logout
```

### `GET /api/auth/me`

Identity of the current session. Useful as a token-validity check.

**Auth:** any signed-in role. **Response `200`**

```json
{ "data": { "id": 1, "email": "admin@meridian.org", "role": "ADMIN" } }
```

**Failures:** `401 UNAUTHORIZED` with no or invalid token.

```bash
curl -s http://localhost:4000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

---

## Assets

### `GET /api/assets`

The asset inventory, each with its current risk. Sorted by `name` ascending.

**Auth:** any signed-in role. **Response `200`** — `data` is an array of:

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `name` | string | Unique |
| `type` | enum | Asset type |
| `phiVolume` | number | PHI records held |
| `encrypted` | boolean | At rest |
| `mfaEnabled` | boolean | |
| `lastAssessedAt` | string \| null | ISO date; `null` means never |
| `createdAt` | string | ISO date |
| `risk` | object \| null | **`null` for an asset never assessed** |
| `risk.score` | number | 0–100, 2 dp |
| `risk.band` | enum | |
| `risk.computedAt` | string | ISO date |

```json
{
  "data": [
    {
      "id": 6, "name": "Billing Engine DB", "type": "DATABASE",
      "phiVolume": 87100, "encrypted": false, "mfaEnabled": false,
      "lastAssessedAt": "2026-06-21T19:45:49.401Z",
      "createdAt": "2026-09-17T19:45:49.402Z",
      "risk": { "score": 100, "band": "EXTREME", "computedAt": "2026-09-21T06:29:39.144Z" }
    }
  ]
}
```

> **Worth knowing for a walkthrough:** a freshly created or freshly imported asset comes
> back with `risk: null` and does **not** appear in `GET /api/risks` at all, because no
> assessment exists for it yet. Give it one by importing a Risk CSV row.

```bash
curl -s http://localhost:4000/api/assets -H "Authorization: Bearer $TOKEN"
```

### `GET /api/assets/:id`

One asset with PHI categories, the full four-factor risk breakdown, and its flows.

**Auth:** any signed-in role.
**Path params:** `id` — positive integer.

**Response `200`**

```json
{
  "data": {
    "id": 1, "name": "Patient Portal", "type": "OTHER",
    "phiVolume": 12400, "encrypted": true, "mfaEnabled": true,
    "lastAssessedAt": "2026-09-05T19:45:49.359Z",
    "createdAt": "2026-09-17T19:45:49.390Z",
    "phiTypes": [
      { "id": 4, "name": "Demographic", "sensitivity": "LOW", "recordsPerDay": 12400 }
    ],
    "risk": {
      "id": 8, "likelihood": 3, "impact": 3, "exposure": 3, "controlGap": 2,
      "score": 8.64, "band": "LOW", "computedAt": "2026-09-17T19:45:49.422Z"
    },
    "flows": {
      "outbound": [{ "to": "Epic EHR Core", "recordsPerDay": 12400, "encrypted": true }],
      "inbound": []
    }
  }
}
```

Note the detail `risk` object is **richer** than the list one: it adds `id` and the four
1–5 input factors. It is `null` for an unassessed asset.

**Failures:** `404 NOT_FOUND` — `"Asset 99999 not found"`. `400 VALIDATION_ERROR` for a
non-numeric id.

```bash
curl -s http://localhost:4000/api/assets/1 -H "Authorization: Bearer $TOKEN"
```

### `POST /api/assets`

**Auth:** `ADMIN` or `ANALYST`.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | Trimmed, 1–120 chars, unique |
| `type` | enum | yes | Asset type |
| `phiVolume` | number | no | Integer ≥ 0 |
| `encrypted` | boolean | no | |
| `mfaEnabled` | boolean | no | |
| `lastAssessedAt` | string \| null | no | Date-coercible |

**Response `201`**

```json
{
  "data": {
    "id": 10, "name": "ZZ-VERIFY-Asset", "type": "API", "phiVolume": 123,
    "encrypted": true, "mfaEnabled": false, "lastAssessedAt": null,
    "createdAt": "2026-09-21T06:28:56.036Z"
  }
}
```

No `risk` key on create — the asset has not been assessed yet.

**Failures:** `403 FORBIDDEN` as VIEWER. `409 CONFLICT` — `"An asset named \"X\" already
exists"`. `400 VALIDATION_ERROR` for a bad enum or negative volume.
`400 MALFORMED_JSON` for unparseable JSON.

```bash
curl -s -X POST http://localhost:4000/api/assets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"ZZ-VERIFY-Asset","type":"API","phiVolume":123,"encrypted":true,"mfaEnabled":false}'
```

### `PATCH /api/assets/:id`

**Auth:** `ADMIN` or `ANALYST`.
**Path params:** `id` — positive integer.
**Request body:** any subset of the `POST` fields, but **at least one** — an empty object
is rejected rather than treated as a silent no-op.

**Response `200`:** the updated asset, same shape as `POST`.

**Failures:** `403` as VIEWER. `404 NOT_FOUND` for an unknown id. `400 VALIDATION_ERROR`
with `path: ""` and message `"Provide at least one field to update"` for `{}`.

```bash
curl -s -X PATCH http://localhost:4000/api/assets/10 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"phiVolume":456,"mfaEnabled":true}'
```

---

## Data flows

### `GET /api/dataflows`

Every PHI movement between assets, sorted by `recordsPerDay` descending. This is the
Sankey data.

**Auth:** any signed-in role. **Response `200`** — `data` is an array of:

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `source` | string | Source asset **name**, not id |
| `target` | string | Target asset **name** |
| `phiType` | string | PHI category name |
| `recordsPerDay` | number | |
| `encrypted` | boolean | In transit |
| `status` | enum | `ok` / `warn` / `violation` — see [Enumerations](#enumerations) |

```json
{
  "data": [
    {
      "id": 5, "source": "Epic EHR Core", "target": "Billing Engine DB",
      "phiType": "Financial", "recordsPerDay": 87100,
      "encrypted": false, "status": "violation"
    }
  ]
}
```

**Failures:** `401` without a token.

```bash
curl -s http://localhost:4000/api/dataflows -H "Authorization: Bearer $TOKEN"
```

---

## Risks

### `GET /api/risks`

The risk register: current assessment per assessed asset, sorted by `score` descending.
Assets with no assessment are absent entirely.

**Auth:** any signed-in role. **Response `200`** — `data` is an array of:

| Field | Type |
|---|---|
| `id` | number |
| `assetId` | number |
| `assetName` | string |
| `likelihood` / `impact` / `exposure` / `controlGap` | number (1–5) |
| `score` | number (0–100, 2 dp) |
| `band` | enum |
| `computedAt` | string (ISO date) |

```json
{
  "data": [
    {
      "id": 1, "assetId": 6, "assetName": "Billing Engine DB",
      "likelihood": 5, "impact": 5, "exposure": 5, "controlGap": 5,
      "score": 100, "band": "EXTREME", "computedAt": "2026-09-21T06:29:39.144Z"
    }
  ]
}
```

```bash
curl -s http://localhost:4000/api/risks -H "Authorization: Bearer $TOKEN"
```

### `POST /api/risks/:assetId/recompute`

Re-scores an asset from the 1–5 factors **currently stored against it** and persists the
result. Use after an assessor edits those judgements.

**Auth:** `ADMIN` or `ANALYST`.
**Path params:** `assetId` — positive integer.
**Request body:** none.

Two behaviours a walkthrough author needs:

- It **updates the existing risk row in place** — it does not append history. Only
  `score`, `band` and `computedAt` change.
- It **requires an existing risk record**. An asset that has never been assessed returns
  `404`, not a newly created score. Create the first assessment by importing a Risk CSV row.

**Response `200`**

```json
{
  "data": {
    "id": 1, "assetId": 6, "assetName": "Billing Engine DB",
    "likelihood": 5, "impact": 5, "exposure": 5, "controlGap": 5,
    "score": 100, "band": "EXTREME", "computedAt": "2026-09-21T06:29:39.144Z",
    "previous": { "score": 100, "band": "EXTREME" }
  }
}
```

`previous` reports the score and band as they stood before this call — with unchanged
inputs it will match the new values exactly.

**Failures:** `403` as VIEWER. `404 NOT_FOUND` — `"Asset 99999 not found"` when the asset
does not exist, or `"No risk record exists for asset 10"` when it exists but is
unassessed. `400 VALIDATION_ERROR` for a non-numeric id. `401` unauthenticated.

```bash
curl -s -X POST http://localhost:4000/api/risks/6/recompute -H "Authorization: Bearer $TOKEN"
```

---

## Vendors

### `GET /api/vendors`

Third-party inventory with BAA compliance and current vendor risk. Sorted by `name`
ascending.

**Auth:** any signed-in role. **Response `200`** — `data` is an array of:

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `name` | string | Unique |
| `baaStatus` | enum | |
| `phiVolume` | number | Records the vendor can reach |
| `lastAssessedAt` | string \| null | |
| `daysSinceAssessment` | number \| null | `null` when never assessed |
| `assessmentOverdue` | boolean | True if never assessed, or more than **365 days** ago |
| `baaCompliant` | boolean | True only when `baaStatus === "SIGNED"` |
| `assetCount` | number | |
| `assets` | string[] | Asset names |
| `risk` | object \| null | `{ score, band, computedAt }`, `null` if unassessed |

```json
{
  "data": [
    {
      "id": 3, "name": "Clarity Imaging Partners", "baaStatus": "PENDING",
      "phiVolume": 51200, "lastAssessedAt": "2026-01-20T19:45:49.549Z",
      "daysSinceAssessment": 243, "assessmentOverdue": false, "baaCompliant": false,
      "assetCount": 2, "assets": ["Imaging Archive (S3)", "Lab Results API"],
      "risk": { "score": 38.4, "band": "MODERATE", "computedAt": "2026-09-17T19:45:49.552Z" }
    }
  ]
}
```

```bash
curl -s http://localhost:4000/api/vendors -H "Authorization: Bearer $TOKEN"
```

### `GET /api/vendors/:id`

One vendor, with the assets it can reach as objects rather than names, and the full
four-factor risk breakdown.

**Auth:** any signed-in role. **Path params:** `id` — positive integer.

**Response `200`**

```json
{
  "data": {
    "id": 1, "name": "Northwind Claims Processing", "baaStatus": "MISSING",
    "phiVolume": 71300, "lastAssessedAt": null, "daysSinceAssessment": null,
    "assessmentOverdue": true, "baaCompliant": false,
    "createdAt": "2026-09-17T19:45:49.540Z",
    "assets": [
      { "id": 6, "name": "Billing Engine DB", "type": "DATABASE",
        "encrypted": false, "grantedAt": "2026-09-17T19:45:49.542Z" }
    ],
    "risk": {
      "id": 1, "likelihood": 5, "impact": 5, "exposure": 5, "controlGap": 5,
      "score": 100, "band": "EXTREME", "computedAt": "2026-09-21T06:29:39.167Z"
    }
  }
}
```

Differences from the list shape: `assets` holds objects, `createdAt` is present,
`assetCount` is not, and `risk` carries the four input factors.

**Failures:** `404 NOT_FOUND` — `"Vendor 99999 not found"`. `400 VALIDATION_ERROR` for a
non-numeric id.

```bash
curl -s http://localhost:4000/api/vendors/1 -H "Authorization: Bearer $TOKEN"
```

### `POST /api/vendors`

**Auth:** `ADMIN` or `ANALYST`.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | Trimmed, 1–120 chars, unique |
| `baaStatus` | enum | no | Defaults to `MISSING` |
| `phiVolume` | number | no | Integer ≥ 0 |
| `lastAssessedAt` | string \| null | no | Date-coercible |

**Response `201`**

```json
{
  "data": {
    "id": 6, "name": "ZZ-VERIFY-Vendor", "baaStatus": "PENDING",
    "phiVolume": 900, "lastAssessedAt": null,
    "createdAt": "2026-09-21T06:29:15.224Z"
  }
}
```

**Failures:** `403` as VIEWER. `409 CONFLICT` for a duplicate name.
`400 VALIDATION_ERROR` for a bad `baaStatus`.

```bash
curl -s -X POST http://localhost:4000/api/vendors \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"ZZ-VERIFY-Vendor","baaStatus":"PENDING","phiVolume":900}'
```

### `PATCH /api/vendors/:id`

**Auth:** `ADMIN` or `ANALYST`. Any subset of the `POST` fields, at least one.

**Response `200`:** the updated vendor, same shape as `POST`.

**Failures:** `403` as VIEWER. `404` unknown id. `400` for `{}`.

```bash
curl -s -X PATCH http://localhost:4000/api/vendors/6 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"baaStatus":"SIGNED"}'
```

### `POST /api/vendors/:id/recompute`

The vendor twin of the asset recompute, with identical semantics: in-place update of the
existing vendor-risk row, `404` if the vendor has never been assessed.

**Auth:** `ADMIN` or `ANALYST`. **Request body:** none.

**Response `200`**

```json
{
  "data": {
    "id": 1, "vendorId": 1, "vendorName": "Northwind Claims Processing",
    "likelihood": 5, "impact": 5, "exposure": 5, "controlGap": 5,
    "score": 100, "band": "EXTREME", "computedAt": "2026-09-21T06:29:39.167Z",
    "previous": { "score": 100, "band": "EXTREME" }
  }
}
```

**Failures:** `403` as VIEWER. `404 NOT_FOUND` — `"Vendor 99999 not found"` or
`"No risk record exists for vendor 6"`. `400` for a non-numeric id.

```bash
curl -s -X POST http://localhost:4000/api/vendors/1/recompute -H "Authorization: Bearer $TOKEN"
```

---

## Access

### `GET /api/access`

Who can reach which asset, with over-permission flags. **Returns an object, not an
array.** Grants are sorted by `riskFlagCount` descending, then by longest idle.

**Auth:** any signed-in role. **Response `200`**

`data.summary`:

| Field | Type | Meaning |
|---|---|---|
| `total` | number | All grants |
| `flagged` | number | Grants with at least one flag |
| `stale` | number | Unused for more than `staleAfterDays` |
| `neverUsed` | number | `lastUsedAt` is null |
| `withoutMfa` | number | Human identity without MFA |
| `inactiveIdentities` | number | Identity is deactivated |
| `excessiveLevel` | number | Non-READ level on a high-volume asset |
| `staleAfterDays` | number | The threshold itself — currently `90` |

`data.grants[]`:

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `identityId`, `identityName`, `identityEmail` | number, string, string \| null | Email is null for service accounts |
| `kind` | string | `USER` or `SERVICE_ACCOUNT` |
| `department` | string \| null | |
| `active`, `mfaEnabled` | boolean | Of the identity |
| `assetId`, `assetName`, `assetType` | number, string, enum | |
| `level` | enum | `READ` / `WRITE` / `ADMIN` |
| `grantedAt` | string | ISO date |
| `lastUsedAt` | string \| null | `null` = never used |
| `daysSinceUse` | number \| null | `null` = never used |
| `daysSinceGrant` | number | |
| `flags` | string[] | See below |
| `riskFlagCount` | number | `flags.length` |

Flag rules (`src/services/accessService.ts`):

| Flag | Raised when |
|---|---|
| `NEVER_USED` | `lastUsedAt` is null |
| `STALE` | Used, but more than 90 days ago |
| `INACTIVE_IDENTITY` | The identity is deactivated |
| `NO_MFA` | Identity is a `USER` (not a service account) and has no MFA |
| `EXCESSIVE_LEVEL` | Level is not `READ` **and** the asset holds more than 50,000 PHI records |

```json
{
  "data": {
    "summary": {
      "total": 9, "flagged": 6, "stale": 1, "neverUsed": 1, "withoutMfa": 3,
      "inactiveIdentities": 1, "excessiveLevel": 6, "staleAfterDays": 90
    },
    "grants": [
      {
        "id": 6, "identityId": 4, "identityName": "Robert Chen (contractor)",
        "identityEmail": "r.chen@contractor.example", "kind": "USER",
        "department": "Radiology", "active": false, "mfaEnabled": false,
        "assetId": 5, "assetName": "Imaging Archive (S3)", "assetType": "CLOUD_STORAGE",
        "level": "ADMIN", "grantedAt": "2025-05-05T19:45:49.564Z",
        "lastUsedAt": "2026-01-17T19:45:49.564Z",
        "daysSinceUse": 246, "daysSinceGrant": 503,
        "flags": ["STALE", "INACTIVE_IDENTITY", "NO_MFA", "EXCESSIVE_LEVEL"],
        "riskFlagCount": 4
      }
    ]
  }
}
```

```bash
curl -s http://localhost:4000/api/access -H "Authorization: Bearer $TOKEN"
```

---

## Threats

### `GET /api/threats`

The detection feed. **Returns an object, not an array.** Threats are sorted unresolved
first, then worst severity, then most recently detected.

**Auth:** any signed-in role. **Response `200`**

`data.summary`:

| Field | Type | Meaning |
|---|---|---|
| `total` | number | All threats |
| `open` | number | Still needing someone |
| `bySeverity` | object | Count keyed by severity |
| `byStatus` | object | Count keyed by status |
| `openCritical` | number | Open **and** `CRITICAL` |

`data.threats[]`:

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `severity` | enum | |
| `status` | enum | |
| `title`, `description` | string | |
| `assetId`, `assetName`, `assetType` | number, string, enum | |
| `detectedAt` | string | ISO date |
| `resolvedAt` | string \| null | |
| `hoursSinceDetection` | number | |
| `open` | boolean | Derived from status — `OPEN` and `INVESTIGATING` are open |

```json
{
  "data": {
    "summary": {
      "total": 5, "open": 3,
      "bySeverity": { "CRITICAL": 2, "HIGH": 1, "MEDIUM": 1, "LOW": 1 },
      "byStatus": { "OPEN": 2, "INVESTIGATING": 1, "RESOLVED": 1, "FALSE_POSITIVE": 1 },
      "openCritical": 2
    },
    "threats": [
      {
        "id": 1, "severity": "CRITICAL", "status": "INVESTIGATING",
        "title": "Bulk PHI export from billing database",
        "description": "847 patient records exported to an unmanaged endpoint...",
        "assetId": 6, "assetName": "Billing Engine DB", "assetType": "DATABASE",
        "detectedAt": "2026-09-17T15:45:49.567Z", "resolvedAt": null,
        "hoursSinceDetection": 86, "open": true
      }
    ]
  }
}
```

Threats are read-only over the API — there is no status-transition endpoint. New threats
arrive only via CSV import.

```bash
curl -s http://localhost:4000/api/threats -H "Authorization: Bearer $TOKEN"
```

---

## Import

Four ADMIN-only endpoints for loading an estate from CSV. Narrative walkthrough and
worked file examples live in [`IMPORT_GUIDE.md`](./IMPORT_GUIDE.md); this section is the
API surface.

Shared upload rules for both `POST` endpoints:

- `multipart/form-data`, single field named **`file`**.
- Filename must end in `.csv` — otherwise `400 BAD_REQUEST`.
- Maximum **2 MB** — otherwise `413 FILE_TOO_LARGE`.
- One file per request. Files are held in memory and never written to disk.
- `:entity` must be one of `assets`, `phi-types`, `data-flows`, `vendors`,
  `access-grants`, `threats`, `risks` — otherwise `404 NOT_FOUND`, and the message lists
  the supported slugs.

### `GET /api/import`

The full column contract for all seven entities — enough for a UI to build its own
field hints without hardcoding anything.

**Auth:** `ADMIN`. **Response `200`** — `data` is an array of seven objects:

| Field | Type | Notes |
|---|---|---|
| `entity` | string | URL slug |
| `label` | string | Display name |
| `model` | string | Underlying model |
| `naturalKey` | string[] | Columns identifying a row |
| `naturalKeyLabel` | string | Plain-English version, echoed in errors |
| `columns[]` | object[] | `column`, `type`, `required`, `values?`, `referencesModel?`, `description` |

```json
{
  "data": [
    {
      "entity": "assets", "label": "Assets", "model": "Asset",
      "naturalKey": ["name"], "naturalKeyLabel": "name",
      "columns": [
        { "column": "name", "type": "string", "required": true,
          "description": "Unique system name." }
      ]
    }
  ]
}
```

**Failures:** `403 FORBIDDEN` as ANALYST or VIEWER (`"Requires one of: ADMIN"`). `401`
unauthenticated.

```bash
curl -s http://localhost:4000/api/import -H "Authorization: Bearer $TOKEN"
```

### `GET /api/import/:entity/template`

A ready-to-fill CSV: header row plus one example row.

**Auth:** `ADMIN`.
**Response `200`** — `Content-Type: text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="medguard-<entity>-template.csv"`.
**The body is raw CSV, not JSON.**

```
name,type,phiVolume,encrypted,mfaEnabled,lastAssessedAt
Epic EHR Core,EHR,412000,true,true,2026-08-14
```

> The example row uses real seeded names. Downloading the assets template and importing
> it unchanged therefore fails with a duplicate-name error — replace the example row
> before importing.

**Failures:** `403` as non-ADMIN. `404 NOT_FOUND` for an unknown entity.

```bash
curl -s http://localhost:4000/api/import/assets/template \
  -H "Authorization: Bearer $TOKEN" -o medguard-assets-template.csv
```

### `POST /api/import/:entity/validate`

Dry run. Parses, type-checks, resolves foreign keys by natural key, and checks for both
in-file and pre-existing duplicates — then **writes nothing**.

**Auth:** `ADMIN`. **Request:** `multipart/form-data` with `file`.

**Response `200` in both outcomes** — a dry run that found problems is still a successful
dry run, so the status stays `200` and `valid` carries the verdict.

| Field | Type | Notes |
|---|---|---|
| `valid` | boolean | |
| `totalRows` | number | Data rows, excluding the header |
| `errors[]` | object[] | `{ row, field, message }` — `row` is the **file** line number, so the first data row is 2 |
| `preview[]` | object[] | Rows as they would be written, after coercion |

Clean file:

```json
{
  "data": {
    "valid": true, "totalRows": 1, "errors": [],
    "preview": [{ "name": "ZZ-VERIFY-Dry", "type": "API", "phiVolume": 1,
                  "encrypted": true, "mfaEnabled": false, "lastAssessedAt": null }]
  }
}
```

File with problems:

```json
{
  "data": {
    "valid": false, "totalRows": 2,
    "errors": [
      { "row": 2, "field": "phiVolume",
        "message": "phiVolume must be a whole number, got \"not-a-number\"" },
      { "row": 2, "field": "type",
        "message": "type must be one of: EHR, DATABASE, API, CLOUD_STORAGE, ANALYTICS, OTHER" }
    ],
    "preview": []
  }
}
```

A row naming something that already exists reports it as an error, because import only
adds: `"Asset \"Epic EHR Core\" already exists, matched on name. Import only adds new records."`

**Failures:** `403` as non-ADMIN. `404` unknown entity. `400 BAD_REQUEST` for no file or
a non-`.csv` filename. `413 FILE_TOO_LARGE` above 2 MB.

```bash
curl -s -X POST http://localhost:4000/api/import/assets/validate \
  -H "Authorization: Bearer $TOKEN" -F "file=@assets.csv"
```

### `POST /api/import/:entity`

The real import. Runs the same validation first and is **all-or-nothing**: if any row
fails, nothing is written.

**Auth:** `ADMIN`. **Request:** `multipart/form-data` with `file`.

**Response `201`** — the validate report plus an `imported` count:

```json
{
  "data": {
    "valid": true, "totalRows": 1, "errors": [],
    "preview": [{ "name": "ZZ-VERIFY-Imported-Asset", "type": "CLOUD_STORAGE",
                  "phiVolume": 77, "encrypted": true, "mfaEnabled": true,
                  "lastAssessedAt": "2026-09-01T00:00:00.000Z" }],
    "imported": 1
  }
}
```

**Response `400` when rows fail** — the full report rides along under `error.report`:

```json
{
  "error": {
    "code": "IMPORT_VALIDATION_FAILED",
    "message": "3 problem(s) found. Nothing was imported.",
    "report": { "valid": false, "totalRows": 2, "errors": [ ... ], "preview": [] }
  }
}
```

**Failures:** `400 IMPORT_VALIDATION_FAILED` as above. `403` as non-ADMIN. `401`
unauthenticated. `404` unknown entity. `400 BAD_REQUEST` no file / non-`.csv`.
`413 FILE_TOO_LARGE` above 2 MB.

```bash
curl -s -X POST http://localhost:4000/api/import/assets \
  -H "Authorization: Bearer $TOKEN" -F "file=@assets.csv"
```

---

# Import CSV contracts

Columns marked **ref** are foreign keys expressed as a natural key — you write the human
name, the server resolves the id. The referenced record **must already exist**, so import
in dependency order: `assets` and `phi-types` first, then everything else.

### `assets` → Asset — natural key: `name`

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Unique system name |
| `type` | enum | yes | `EHR`, `DATABASE`, `API`, `CLOUD_STORAGE`, `ANALYTICS`, `OTHER` |
| `phiVolume` | int | no | PHI records held. Defaults to 0 |
| `encrypted` | boolean | no | At rest. Defaults to false |
| `mfaEnabled` | boolean | no | Defaults to false |
| `lastAssessedAt` | date | no | `YYYY-MM-DD`. Blank means never |

### `phi-types` → PHIType — natural key: `name`

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Unique PHI category name |
| `sensitivity` | enum | yes | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |

### `data-flows` → DataFlow — natural key: source asset + target asset + PHI type

| Column | Type | Required | Notes |
|---|---|---|---|
| `sourceAssetName` | string | yes | **ref → Asset.** Must already exist |
| `targetAssetName` | string | yes | **ref → Asset.** Must already exist |
| `phiTypeName` | string | yes | **ref → PHIType.** Must already exist |
| `recordsPerDay` | int | yes | |
| `encrypted` | boolean | no | In transit. **Defaults to true** |

### `vendors` → Vendor — natural key: `name`

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Unique vendor name |
| `baaStatus` | enum | no | `SIGNED`, `PENDING`, `EXPIRED`, `MISSING`. Defaults to `MISSING` |
| `phiVolume` | int | no | Defaults to 0 |
| `lastAssessedAt` | date | no | `YYYY-MM-DD` |

### `access-grants` → AccessGrant — natural key: identity display name + asset name

| Column | Type | Required | Notes |
|---|---|---|---|
| `identityName` | string | yes | **ref → Identity.displayName.** Must exist and be unambiguous |
| `assetName` | string | yes | **ref → Asset.** Must already exist |
| `level` | enum | no | `READ`, `WRITE`, `ADMIN`. Defaults to `READ` |
| `grantedAt` | date | no | Defaults to today |
| `lastUsedAt` | date | no | Blank means never used |

### `threats` → Threat — natural key: asset name + title

| Column | Type | Required | Notes |
|---|---|---|---|
| `assetName` | string | yes | **ref → Asset.** Must already exist |
| `severity` | enum | yes | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `status` | enum | no | `OPEN`, `INVESTIGATING`, `RESOLVED`, `FALSE_POSITIVE`. Defaults to `OPEN` |
| `title` | string | yes | Short headline |
| `description` | string | yes | What was detected |
| `detectedAt` | date | no | Defaults to today |
| `resolvedAt` | date | no | Blank while still open |

### `risks` → Risk — natural key: asset name

| Column | Type | Required | Notes |
|---|---|---|---|
| `assetName` | string | yes | **ref → Asset.** Must already exist |
| `likelihood` | int | yes | Assessor judgement, 1–5 |
| `impact` | int | yes | Assessor judgement, 1–5 |
| `exposure` | int | yes | Assessor judgement, 1–5 |
| `controlGap` | int | yes | Assessor judgement, 1–5 |

Importing a `risks` row is how a newly created asset gets its first score — and therefore
how it enters `GET /api/risks` and stops showing `risk: null`.

---

# Known limits

Current as of this reference; none are bugs, all are scope decisions.

- **No pagination** on any list endpoint. Every list returns the full set.
- **No DELETE endpoints.** Nothing created through the API can be removed through it.
- **No filtering or search query parameters.** Clients filter client-side.
- **Threats are read-only.** No status-transition endpoint; they arrive only by import.
- **Import only adds.** There is no update-or-insert; a row matching an existing natural
  key is reported as an error.
- **No token refresh and no revocation.** Tokens live 8 hours; logout clears the cookie
  but cannot invalidate a token the client already holds.
- **Recompute needs a prior assessment.** It will not create a first risk record.
