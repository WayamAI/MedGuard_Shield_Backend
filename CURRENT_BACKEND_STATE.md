# CURRENT_BACKEND_STATE.md

**Forensic read-only audit of the backend repository.**

| | |
|---|---|
| Audit date | 2026-09-22 |
| Repository root | `/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend` |
| Commit audited | `53d545655c02b7609be3fe103be7e64b70573687` |
| Branch | `main` |
| Mode | READ-ONLY — no source, schema, migration, database, dependency, config or Git mutation |

**Headline:** the codebase is unchanged since 2026-09-21 and is in good technical health
(typecheck, lint, build and unit tests all pass). The **database is not** what it was:
it was re-migrated and reseeded on 2026-09-22, and **eight extra assets were bulk-inserted
after the seed with no PHI links, no data flows and no risk scores**. Separately, the
product has **not begun** its rename to Drishti — there is zero occurrence of "Drishti"
anywhere in the repository.

Two caveats on scope, stated up front:

1. **The integration test suite was NOT run.** Its `globalSetup` executes
   `npx prisma migrate deploy`, and its fixtures `TRUNCATE` every table. Both are
   explicitly prohibited by this audit's rules, even against the test database. Only the
   79 database-free unit tests were executed. See [Step 15](#step-15--testing-audit).
2. Anything not directly observed is listed in
   [Unknown / unverified](#15-unknown--unverified-areas) rather than inferred.

---

## Contents

- [Step 1 — Repository state](#step-1--repository-state)
- [Step 2 — Backend stack](#step-2--backend-stack)
- [Step 3 — Architecture map](#step-3--architecture-map)
- [Step 4 — Database / Prisma audit](#step-4--database--prisma-audit)
- [Step 5 — Migration state](#step-5--migration-state)
- [Step 6 — Complete API inventory](#step-6--complete-api-inventory)
- [Step 7 — CRUD completeness](#step-7--crud-completeness)
- [Step 8 — Authentication](#step-8--authentication)
- [Step 9 — RBAC / authorization](#step-9--rbac--authorization)
- [Step 10 — Risk engine audit](#step-10--risk-engine-audit)
- [Step 11 — CSV import system](#step-11--csv-import-system)
- [Step 12 — Security audit](#step-12--security-audit)
- [Step 13 — Audit logging](#step-13--audit-logging)
- [Step 14 — API / frontend compatibility](#step-14--api--frontend-compatibility)
- [Step 15 — Testing audit](#step-15--testing-audit)
- [Step 16 — Build / typecheck / lint](#step-16--build--typecheck--lint)
- [Step 17 — Performance / scalability](#step-17--performance--scalability)
- [Step 18 — Integrations](#step-18--integrations)
- [Step 19 — Multi-tenancy](#step-19--multi-tenancy)
- [Step 20 — Branding audit](#step-20--branding-audit)
- [Step 21 — Current backend gaps](#step-21--current-backend-gaps)
- [Step 22 — Final backend state](#backend-current-state)

---

# Step 1 — Repository state

| Item | Value |
|---|---|
| Repository root | `/Users/arkabera/Desktop/Wayam AI/MEDGUARD/medguard-backend` |
| Current branch | `main` |
| Remote | `origin` → `https://github.com/WayamAI/MedGuard_Shield_Backend.git` |
| HEAD SHA | `53d545655c02b7609be3fe103be7e64b70573687` |
| HEAD date | 2026-09-21 12:05:33 +0530 |
| HEAD subject | `docs: add API_REFERENCE.md covering all 22 endpoints` |
| Working tree | Clean except one untracked directory |
| Untracked | `samples/` (`medguard_assets_sample_100.csv`, `.DS_Store`) |
| Local vs remote | **`main` is 1 commit ahead of `origin/main` — `53d5456` is unpushed** |
| Tags | none |

### Branches

| Branch | Local | Remote | Tip date | Tip subject |
|---|---|---|---|---|
| `main` | ✅ checked out | ✅ | 2026-09-21 (local) / 2026-09-21 10:46 (remote) | local ahead by 1 |
| `feature/data-import-backend` | ✅ | ✅ | 2026-09-18 00:43 | `test: close the endpoint coverage gaps…` |
| `post-demo/expansion` | ❌ | ✅ | 2026-09-15 08:48 | `docs(env): document TEST_DATABASE_URL…` |

### Recent history (last 10)

```
53d5456 docs: add API_REFERENCE.md covering all 22 endpoints
4b363b4 docs(runbook): say what happens if an asset is imported live
48fc18f docs: add BACKEND_QA_REPORT.md
46e149c test: close the endpoint coverage gaps found by auditing the inventory
3489ec0 docs(import): add IMPORT_GUIDE.md and point the runbook at it
2b820d9 fix(import): handle mixed line endings and report the true file line
ad5b379 test(import): cover every entity, RBAC, duplicates and file safety
98722df feat(import): add template, validate and import endpoints
a28aebd feat(import): add the CSV contract and pure parsing layer
56d732d docs(runbook): record two cleanup traps and seed-freshness timing
```

**No code commits since 2026-09-18.** The last four commits are documentation only.

### Naming: MedGuard vs Drishti

- Repository still uses **MedGuard** naming throughout — package name, remote URL,
  database names, log prefixes, cookie name, CI, schema header comment, all docs.
- **Migration to Drishti has NOT begun.** Zero occurrences of "Drishti"/"drishti"/"DRISHTI"
  in any tracked or untracked file (excluding `node_modules`). Full detail in
  [Step 20](#step-20--branding-audit).

### ⚠ Finding 1.1 — Untracked `samples/medguard_assets_sample_100.csv` is incompatible with the import contract

100 data rows. The `type` column contains **20 distinct free-text values, 19 of which are
invalid** against the `AssetType` enum (`EHR`, `DATABASE`, `API`, `CLOUD_STORAGE`,
`ANALYTICS`, `OTHER`). Only `EHR` is valid.

Invalid values present: `AI Model`, `API Gateway`, `Analytics Platform`, `Backup System`,
`Billing System`, `CRM`, `Cloud Storage`, `Data Warehouse`, `Device Integration`,
`Email System`, `File Server`, `Identity Provider`, `Imaging System`, `Lab System`,
`Messaging System`, `Patient Portal`, `Pharmacy System`, `Scheduling System`,
`Telehealth Platform`.

Consequence: importing this file **fails every non-EHR row** with
`type must be one of: EHR, DATABASE, API, CLOUD_STORAGE, ANALYTICS, OTHER`, and because
import is all-or-nothing, **nothing is written at all**. The file is either a scale-test
fixture that was never reconciled with the enum, or evidence that the intended asset
taxonomy is far wider than the schema models. Evidence: `src/services/importSpec.ts:65-85`
(`ASSET_TYPES`), `prisma/schema.prisma` (`enum AssetType`),
`src/services/importParsing.ts` (`coerce`, `case "enum"`).

---

# Step 2 — Backend stack

Verified against `package.json` and the actually-installed `node_modules` versions.

| Concern | Actual | Evidence |
|---|---|---|
| Runtime requirement | Node `>=20` (`engines`); CI pins Node 22; **local machine runs v26.7.0** | `package.json`, `.github/workflows/ci.yml` |
| Package manager | npm 11.19.0, `package-lock.json` present | lockfile |
| Module system | ESM (`"type": "module"`), `NodeNext` resolution | `package.json`, `tsconfig.json` |
| Web framework | **Express 5.2.1** | installed |
| Language | TypeScript 5.9.3, `strict: true`, `noUncheckedIndexedAccess: true` | `tsconfig.json` |
| ORM | **Prisma 7.10.0** with `@prisma/client` 7.10.0 | installed |
| DB driver | `pg` 8.23.0 via `@prisma/adapter-pg` (Prisma 7 requires an explicit driver adapter) | `src/lib/prisma.ts` |
| Database | PostgreSQL. CI uses `postgres:14` | `.github/workflows/ci.yml` |
| Prisma client output | **Generated into `src/generated/prisma`, gitignored** | `prisma/schema.prisma` generator block, `.gitignore` |
| JWT | `jsonwebtoken` 9.0.3, HS256 | `src/services/authService.ts` |
| Password hashing | `bcryptjs` 3.0.3, cost factor 10 | `src/services/authService.ts:hashPassword` |
| Validation | **Zod 4.6.2** | route files, `src/middleware/validate.ts` |
| Security headers | `helmet` 8.3.0 (CSP disabled — JSON-only service) | `src/app.ts:23` |
| Rate limiting | `express-rate-limit` 8.7.0, two tiers | `src/middleware/security.ts` |
| CORS | `cors` 2.8.6, single origin from env, `credentials: true` | `src/app.ts:31-33` |
| Logging | **None.** 4 raw `console.*` calls; no pino/winston/morgan | see Step 12 |
| Testing | **Vitest 3.2.7** + Supertest 7.2.2 | `vitest.config.ts` |
| API documentation | Hand-written Markdown only. **No OpenAPI/Swagger** | `API_REFERENCE.md` |
| File upload | `multer` 2.4.0, memory storage, 2 MB, 1 file | `src/routes/import.ts` |
| CSV parser | `csv-parse` 7.0.2 (sync API) | `src/services/importParsing.ts` |
| Env config | `dotenv` 17.4.2; no schema validation of env vars | `src/server.ts:1` |
| Lint | ESLint 10.10.0 + typescript-eslint 8.70.0 | `eslint.config.js` |

### ⚠ Finding 2.1 — The documented stack says Jest; the repository uses Vitest

The baseline brief lists "Jest + Supertest". There is **no Jest anywhere** — no dependency,
no config, no reference in `package.json`. Testing is Vitest 3.2.7. Supertest is correct.
Any onboarding doc or CI assumption naming Jest is wrong.

### New/changed dependencies vs the documented baseline

None added. The dependency set matches what the previous documentation described, with the
Jest→Vitest discrepancy above being a documentation error rather than a change.

---

# Step 3 — Architecture map

### Layers as they actually exist

| Layer | Present? | Location |
|---|---|---|
| Entrypoint | ✅ | `src/server.ts` — dotenv, `createApp()`, `listen`, SIGINT/SIGTERM pool shutdown |
| Express app factory | ✅ | `src/app.ts` — `createApp()` returns a fresh app (used by every test) |
| Routes | ✅ | `src/routes/*.ts` — 8 routers |
| **Controllers** | ❌ **No controller layer exists** | route handlers call services directly |
| Services | ✅ | `src/services/*.ts` — 12 modules |
| **Repository / data-access layer** | ❌ **None** | services call `prisma.*` directly |
| Middleware | ✅ | `src/middleware/{auth,validate,security,errorHandler}.ts` |
| Prisma client | ✅ | `src/lib/prisma.ts` — process-global singleton |
| Validators | ✅ | Zod schemas defined **inline inside each route file** |
| Errors | ✅ | `src/lib/errors.ts` (`HttpError`, `NotFoundError`, `BadRequestError`, `ConflictError`) |
| Risk engine | ✅ | `src/services/riskEngine.ts` + pure `riskScoring.ts` |
| Import subsystem | ✅ | `importSpec.ts` (contract), `importParsing.ts` (pure), `importService.ts` (DB) |
| Config module | ❌ | env read ad hoc via `process.env` at point of use |
| Logging module | ❌ | none |
| Tests | ✅ | `src/services/*.test.ts` (unit), `tests/integration/*.test.ts` |

A consistent and deliberate design idiom runs through the codebase: **pure logic is split
from database logic so it can be unit-tested without Postgres** — `riskScoring.ts` vs
`riskEngine.ts`, `flowStatus.ts` vs `dataFlowService.ts`, `importParsing.ts` vs
`importService.ts`.

### Actual request flow

Verified against `src/app.ts` ordering:

```
HTTP request
  → helmet                      (src/app.ts:23)         security headers on every response
  → trust proxy = 1             (src/app.ts:27)
  → global rate limiter         (src/app.ts:29)         300 / 15 min
  → cors                        (src/app.ts:33)         single origin, credentials
  → express.json()              (src/app.ts:35)
  → [ /health                 ] (src/app.ts:39)         PUBLIC — returns here
  → [ /api/auth/login         ] (src/app.ts:45)         login limiter, then authRouter
  → [ /api/auth/*             ] (src/app.ts:46)         PUBLIC router
  → requireAuth                 (src/app.ts:49)         ← auth gate for ALL of /api
  → router                      (src/app.ts:51-57)
      → requireRole([...])                              authorization, write routes only
      → validate({params, body})                        Zod; writes parsed values back
      → inline handler                                  NO controller layer
          → service function                            src/services/*
              → prisma.<model>.*                        singleton client
                  → PostgreSQL
  → res.json({ data })
  → notFoundHandler             (src/app.ts:59)
  → errorHandler                (src/app.ts:60)         single place an error becomes a response
```

Deviations worth noting, all supported by code:

- `GET /api/auth/me` mounts `requireAuth` **itself** (`src/routes/auth.ts:42`) because the
  whole `authRouter` is mounted before the global `/api` gate.
- `validate()` **mutates the request**, writing parsed values back so handlers receive real
  numbers instead of route-param strings (`src/middleware/validate.ts:19-21`).
- Most handlers re-`parse()` the schema a second time inside the try block (e.g.
  `src/routes/assets.ts:42`). Harmless, but duplicated work.

---

# Step 4 — Database / Prisma audit

`prisma/schema.prisma`, 309 lines. Provider `postgresql`. **12 models, 9 enums.**

All models from the documented baseline still exist. **Zero new models.** `Role` exists as
an **enum, not a model**.

### Model matrix

| Model | Purpose | Important fields | Relationships | Constraints | Current usage |
|---|---|---|---|---|---|
| `User` | Account that logs into the API itself | `email`, `passwordHash?`, `externalAuthId?`, `role` | — | `@unique email`, `@unique externalAuthId`, `@@index([role])` | Auth only. No user-management endpoint |
| `Asset` | System storing/processing PHI | `name`, `type`, `phiVolume`, `encrypted`, `mfaEnabled`, `lastAssessedAt?` | 7 relations | `@unique name`, `@@index([type])` | Full CRU, imports |
| `PHIType` | PHI category | `name`, `sensitivity` | `AssetPHI`, `DataFlow` | `@unique name`, `@@index([sensitivity])` | **Import only — no REST endpoint** |
| `AssetPHI` | Which PHI lives in which asset | `recordsPerDay` | `Asset`, `PHIType` | composite `@@id([assetId, phiTypeId])` | Read via asset detail. **No endpoint** |
| `DataFlow` | Directed PHI movement | `recordsPerDay`, `encrypted` | `sourceAsset`, `targetAsset`, `phiType` | 3 indexes; **no unique constraint on the natural key** | List endpoint + import |
| `Risk` | Scored asset risk | 4×1-5 inputs, `score`, `band`, `computedAt` | `Asset` | `@@index` on assetId/band/computedAt; **NO unique on assetId** | List, recompute, import |
| `Vendor` | Third party touching PHI | `name`, `baaStatus`, `phiVolume`, `lastAssessedAt?` | `assetAccess`, `risks` | `@unique name`, `@@index([baaStatus])` | Full CRU, recompute, import |
| `VendorAssetAccess` | Vendor→asset reach | `grantedAt` | `Vendor`, `Asset` | composite `@@id` | Read via vendor detail. **No endpoint** |
| `VendorRisk` | Scored vendor risk | same 4 inputs + `score`, `band` | `Vendor` | 2 indexes; **no unique on vendorId** | Read + recompute |
| `Identity` | Person/service account holding PHI access | `displayName`, `email?`, `kind`, `department?`, `role`, `active`, `mfaEnabled` | `grants` | `@unique email`; **`displayName` NOT unique** | Read via access. **No endpoint** |
| `AccessGrant` | One identity's access to one asset | `level`, `grantedAt`, `lastUsedAt?` | `Identity`, `Asset` | `@@unique([identityId, assetId])` | List endpoint + import |
| `Threat` | Detection against an asset | `severity`, `status`, `title`, `description`, `detectedAt`, `resolvedAt?` | `Asset` | 4 indexes | List endpoint + import |

### Enums (9)

`Role` (ADMIN/ANALYST/VIEWER) · `AssetType` (6) · `Sensitivity` (4) · `BaaStatus` (4) ·
`IdentityKind` (USER/SERVICE_ACCOUNT) · `AccessLevel` (READ/WRITE/ADMIN) ·
`ThreatSeverity` (4) · `ThreatStatus` (4) · `RiskBand` (5)

### Cascade behaviour

- `onDelete: Cascade` on `AssetPHI`, `DataFlow` (both asset FKs), `Risk`,
  `VendorAssetAccess`, `VendorRisk`, `AccessGrant`, `Threat`.
- **`onDelete: Restrict`** on `DataFlow.phiType` — a PHI type in use cannot be deleted.
- Deleting an `Asset` would therefore cascade away its PHI links, flows, risks, grants,
  threats and vendor access. **This is unreachable through the API** — no DELETE endpoint
  and no Prisma `.delete()` call exists anywhere in `src/`.

### Audit / tenancy / lifecycle fields

| Field class | Present? | Evidence |
|---|---|---|
| `createdAt` | Partial — on `User`, `Asset`, `Vendor`, `Identity` only. **Absent from `DataFlow`, `AssetPHI`, `AccessGrant`, `Threat`, `Risk`, `VendorRisk`** | grep of schema |
| `updatedAt` | ❌ **Zero occurrences on any model** | `grep updatedAt prisma/schema.prisma` → none |
| Soft delete (`deletedAt`/`isDeleted`/`archived`) | ❌ none | grep → none |
| `orgId` / `organizationId` / `tenantId` | ❌ **none, anywhere** | grep of schema and `src/` → none |
| Audit actor fields (`actorId`/`performedBy`) | ❌ none | grep → none |

**Multi-tenancy does not exist.** The schema header states this as an explicit decision:
*"Deliberately minimal: no multi-tenancy. Every asset belongs to the single demo
organisation, so there is no orgId anywhere."* (`prisma/schema.prisma:1-4`).

### ⚠ Finding 4.1 — `Risk` has no unique constraint on `assetId`

The application treats "the latest `Risk` row" as the asset's current risk
(`src/services/assetService.ts:5-9`, `orderBy computedAt desc, take 1`), and import
refuses a second row for an already-assessed asset (`importService.ts`, `case "risks"`).
But **the database permits many `Risk` rows per asset** — the one-assessment-per-asset rule
is enforced only in application code. Direct SQL, a future endpoint, or a concurrent
import could create competing rows. Same for `VendorRisk.vendorId`.

### ⚠ Finding 4.2 — `DataFlow` has no unique constraint on its natural key

In-file and pre-existing duplicate detection for `(sourceAssetId, targetAssetId, phiTypeId)`
is done in application code (`importService.ts`, `case "data-flows"`) with no backing
`@@unique`. Two concurrent imports could both pass the check and both insert.

### ⚠ Finding 4.3 — `Identity.displayName` is not unique but is used as an import natural key

`importService.ts:loadRefIndex` handles this explicitly and correctly: a duplicated
display name maps to `-1` and is reported as ambiguous rather than silently resolved. The
handling is sound; the underlying data model remains ambiguous by design.

---

# Step 5 — Migration state

| Item | Value |
|---|---|
| Migration count | **4** |
| Provider lock | `prisma/migrations/migration_lock.toml` |
| First | `20260911065331_init` — `User`, `Asset`, `PHIType`, `AssetPHI`, `DataFlow`, `Risk` (142 lines) |
| Then | `20260912071535_add_vendor_module` — `Vendor`, `VendorAssetAccess`, `VendorRisk` (62) |
| Then | `20260912071907_add_access_module` — `Identity`, `AccessGrant` (56) |
| Latest | `20260912072134_add_threat_module` — `Threat` (34) |
| Latest migration date | **2026-09-12** |
| Destructive SQL | **None.** No `DROP TABLE`, `DROP COLUMN`, `TRUNCATE` or `DELETE FROM` in any migration — all four are purely additive |
| Migration TODOs | None |

### Schema ↔ migration synchronisation

12 models in `schema.prisma`; 12 `CREATE TABLE` statements across the 4 migrations; names
match one-for-one. `schema.prisma` was last *committed* on 2026-09-15, three days after the
last migration — but that commit was `docs(schema): correct two comments overtaken by
shipped work`, i.e. **comment-only**. No structural drift is evident from the file history.

> Not verified: `prisma migrate diff` / `migrate status` were not run, as both are
> `prisma migrate` subcommands and this audit forbids them. Synchronisation above is
> inferred from file contents and commit history, not from Prisma's own drift detection.

### ⚠ Finding 5.1 — The development database was re-migrated and reseeded TODAY

Read-only query against `medguard_dev._prisma_migrations`:

```
20260911065331_init              | 2026-09-22 15:28 | ok
20260912071535_add_vendor_module | 2026-09-22 15:28 | ok
20260912071907_add_access_module | 2026-09-22 15:28 | ok
20260912072134_add_threat_module | 2026-09-22 15:28 | ok
```

All four migrations carry a `finished_at` of **2026-09-22**, none rolled back. On
2026-09-21 this same database held seed data created 2026-09-17. The database has therefore
been **dropped/recreated and re-migrated within the last day**, by something outside this
audit. 4 on disk, 4 applied — no pending migrations.

---

# Step 6 — Complete API inventory

Derived from `src/app.ts` mounting plus every `src/routes/*.ts` file. **22 endpoints.**
There is no controller layer, so the "Controller" column names the route file and handler.

| # | Method | Endpoint | Auth | Role | Route file | Service | DB access | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/health` | ❌ public | — | `app.ts:39` inline | — | none | Live |
| 2 | POST | `/api/auth/login` | ❌ public | — | `routes/auth.ts:17` | `authService.login` | `user.findUnique` | Live |
| 3 | POST | `/api/auth/logout` | ❌ public | — | `routes/auth.ts:35` | — | none | Live |
| 4 | GET | `/api/auth/me` | ✅ | any | `routes/auth.ts:42` | — (reads `req.user`) | none | Live |
| 5 | GET | `/api/assets` | ✅ | any | `routes/assets.ts:32` | `listAssets` | `asset.findMany` | Live |
| 6 | GET | `/api/assets/:id` | ✅ | any | `routes/assets.ts:40` | `getAssetById` | `asset.findUnique` | Live |
| 7 | POST | `/api/assets` | ✅ | **ADMIN, ANALYST** | `routes/assets.ts:49` | `createAsset` | `findUnique` + `create` | Live |
| 8 | PATCH | `/api/assets/:id` | ✅ | **ADMIN, ANALYST** | `routes/assets.ts:58` | `updateAsset` | `findUnique` ×2 + `update` | Live |
| 9 | GET | `/api/dataflows` | ✅ | any | `routes/dataflows.ts:6` | `listDataFlows` | `dataFlow.findMany` | Live |
| 10 | GET | `/api/risks` | ✅ | any | `routes/risks.ts:21` | `listRisks` | `risk.findMany` | Live |
| 11 | POST | `/api/risks/:assetId/recompute` | ✅ | **ADMIN, ANALYST** | `routes/risks.ts:29` | `recomputeAssetRisk` | `findUnique`+`findFirst`+`update` | Live |
| 12 | GET | `/api/vendors` | ✅ | any | `routes/vendors.ts:28` | `listVendors` | `vendor.findMany` | Live |
| 13 | GET | `/api/vendors/:id` | ✅ | any | `routes/vendors.ts:36` | `getVendorById` | `vendor.findUnique` | Live |
| 14 | POST | `/api/vendors` | ✅ | **ADMIN, ANALYST** | `routes/vendors.ts:45` | `createVendor` | `findUnique` + `create` | Live |
| 15 | PATCH | `/api/vendors/:id` | ✅ | **ADMIN, ANALYST** | `routes/vendors.ts:53` | `updateVendor` | `findUnique` ×2 + `update` | Live |
| 16 | POST | `/api/vendors/:id/recompute` | ✅ | **ADMIN, ANALYST** | `routes/vendors.ts:65` | `recomputeVendorRisk` | `findUnique`+`findFirst`+`update` | Live |
| 17 | GET | `/api/access` | ✅ | any | `routes/access.ts:6` | `listAccessGrants` | `accessGrant.findMany` | Live |
| 18 | GET | `/api/threats` | ✅ | any | `routes/threats.ts:6` | `listThreats` | `threat.findMany` | Live |
| 19 | GET | `/api/import` | ✅ | **ADMIN** | `routes/import.ts:82` | `importSpec` (pure) | none | Live |
| 20 | GET | `/api/import/:entity/template` | ✅ | **ADMIN** | `routes/import.ts:105` | `templateCsv` (pure) | none | Live |
| 21 | POST | `/api/import/:entity/validate` | ✅ | **ADMIN** | `routes/import.ts:116` | `validateImport` | reads only | Live |
| 22 | POST | `/api/import/:entity` | ✅ | **ADMIN** | `routes/import.ts:128` | `runImport` | **`$transaction`** + `createMany` | Live |

### Endpoint areas that DO NOT exist

Confirmed absent by exhaustive grep of `src/routes/` and `src/app.ts`:

| Requested area | Status |
|---|---|
| PHI types (`/api/phi-types`) | ❌ **No endpoint.** Model is import-only |
| Identities (`/api/identities`) | ❌ No endpoint |
| Users / user management | ❌ No endpoint |
| Exports (any format) | ❌ **No export endpoint at all** |
| Settings | ❌ None |
| Audit | ❌ None |
| Policies | ❌ None |
| Controls | ❌ **None** — despite "Control" being in the stated conceptual model |
| Remediation | ❌ None |
| AI / ML | ❌ None |
| DELETE (any entity) | ❌ **Zero DELETE routes** |
| Refresh token | ❌ None |
| Password reset | ❌ None |
| Health under `/api` | ❌ `/api/health` returns 401 (auth gate) — probe must use `/health` |

---

# Step 7 — CRUD completeness

| Entity | Create | Read | Update | Delete | RBAC | Validation | Transactional? |
|---|---|---|---|---|---|---|---|
| Asset | **REAL** (POST + import) | **REAL** (list + detail) | **REAL** (PATCH) | **MISSING** | ✅ ADMIN/ANALYST write | ✅ Zod + CSV coercion | Import only |
| Vendor | **REAL** (POST + import) | **REAL** (list + detail) | **REAL** (PATCH) | **MISSING** | ✅ ADMIN/ANALYST write | ✅ Zod + CSV | Import only |
| Risk | **PARTIAL** — import only; no POST endpoint | **REAL** (list + embedded) | **PARTIAL** — recompute only; the 4 inputs cannot be edited via API | **MISSING** | ✅ ADMIN/ANALYST | ✅ 1-5 range enforced | Import only |
| VendorRisk | **MISSING** — no create path at all (seed only) | **REAL** (embedded in vendor) | **PARTIAL** — recompute only | **MISSING** | ✅ | ✅ | — |
| DataFlow | **PARTIAL** — import only | **REAL** (list) | **MISSING** | **MISSING** | ✅ ADMIN import | ✅ CSV | Import only |
| PHIType | **PARTIAL** — import only | **PARTIAL** — only nested in asset detail | **MISSING** | **MISSING** | ✅ ADMIN import | ✅ CSV | Import only |
| AssetPHI | **MISSING** — no create path (seed only) | **PARTIAL** — nested in asset detail | **MISSING** | **MISSING** | — | — | — |
| Identity | **MISSING** — seed only | **PARTIAL** — flattened into `/api/access` | **MISSING** | **MISSING** | — | — | — |
| AccessGrant | **PARTIAL** — import only | **REAL** (list) | **MISSING** | **MISSING** | ✅ ADMIN import | ✅ CSV | Import only |
| Threat | **PARTIAL** — import only | **REAL** (list) | **MISSING** — no status transition | **MISSING** | ✅ ADMIN import | ✅ CSV | Import only |
| VendorAssetAccess | **MISSING** — seed only | **PARTIAL** — nested in vendor detail | **MISSING** | **MISSING** | — | — | — |
| User | **MISSING** — seed only | **PARTIAL** — own identity via `/me` | **MISSING** | **MISSING** | — | — | — |

### DELETE — definitive answer

**DELETE endpoints do not exist and no deletion code path exists.**

- `grep` for `.delete(` / `.del(` across `src/routes/` and `src/app.ts` → **zero matches**.
- `grep` for `.delete(` / `deleteMany` across all of `src/` (excluding generated client) →
  **zero matches**.
- The only destructive SQL in the repository is `TRUNCATE ... RESTART IDENTITY CASCADE` in
  **test fixtures** (`tests/helpers.ts:57`), guarded by `tests/setup/globalSetup.ts`, which
  refuses to run against a database whose name does not contain "test".

### Cross-cutting CRUD behaviour

| Concern | State | Evidence |
|---|---|---|
| Validation | Zod on every write; CSV coercion on every import column | route files, `importParsing.ts:coerce` |
| Authorization | `requireRole` on every write; reads open to any signed-in role | see Step 9 |
| Transaction safety | **Only import is transactional.** `createAsset`/`updateAsset`/`createVendor`/`updateVendor`/recompute are multi-statement but NOT wrapped in `$transaction` | `grep -F '$transaction' src/` → 1 hit, `importService.ts:324` |
| Error handling | Single `errorHandler`; typed `HttpError` subclasses; P2025 → 404 | `src/middleware/errorHandler.ts` |
| Duplicate handling | Pre-check read then create (see Finding 7.1) | `assetService.ts:111`, `vendorService.ts:110` |
| FK behaviour | Import resolves natural keys and rejects unresolvable refs; schema enforces FKs with cascade/restrict | `importService.ts:resolveRefs` |
| Ownership / org checks | **None — no ownership concept exists** | no `orgId`/`userId` on any domain model |

### ⚠ Finding 7.1 — Duplicate-name handling is a TOCTOU read-then-write, and the raw P2002 is unhandled

`createAsset` does `findUnique` then `create` (`src/services/assetService.ts:111-114`); the
comment above it claims *"a duplicate surfaces as Prisma's P2002 — translated to a 409
here"*, but **no P2002 translation exists anywhere**. `errorHandler` maps only `P2025`
(`src/middleware/errorHandler.ts:97`).

Consequence: two concurrent creates with the same name can both pass the pre-check; the
loser hits the database unique constraint, raises an untranslated `P2002`, and falls through
to the generic branch as **HTTP 500 `INTERNAL_ERROR`** instead of 409. Identical pattern in
`updateAsset`, `createVendor`, `updateVendor`. Low probability at demo concurrency; a real
correctness gap under load, and the code comment actively misdescribes the behaviour.

---

# Step 8 — Authentication

Implementation: `src/services/authService.ts`, `src/middleware/auth.ts`, `src/routes/auth.ts`.

| Capability | Status | Evidence / detail |
|---|---|---|
| Login | **IMPLEMENTED** | `POST /api/auth/login`; `authService.login` |
| Password verification | **IMPLEMENTED** | `bcrypt.compare`, `authService.ts:60` |
| Password hashing | **IMPLEMENTED** | `bcrypt.hash(plaintext, 10)`, `authService.ts:47` |
| User enumeration resistance | **IMPLEMENTED** | Identical `"Invalid email or password"` for unknown address and wrong password (`authService.ts:56-61`) |
| JWT creation | **IMPLEMENTED** | `jwt.sign`, HS256 default |
| JWT claims | **IMPLEMENTED** | `{ id, email, role }` + `iat`, `exp`. **No `sub`, `iss`, `aud`, or `jti`** |
| Expiration | **IMPLEMENTED** | `TOKEN_TTL_SECONDS = 60*60*8` — 8 hours |
| Secret handling | **IMPLEMENTED** | `signingSecret()` throws if unset or <16 chars — refuses to fall back to a default (`authService.ts:37-45`) |
| Authorization header | **IMPLEMENTED** | `Bearer`, case-insensitive prefix (`auth.ts:12-14`) |
| Cookie support | **IMPLEMENTED** | `medguard_token`, `httpOnly`, `sameSite: lax`, `maxAge` |
| Invalid token handling | **IMPLEMENTED** | `verifyToken` catch-all → 401, claim shape validated (`authService.ts:70-81`) |
| Expired token handling | **IMPLEMENTED** | Same 401 path via `jwt.verify` throw |
| Logout | **PARTIAL** | Clears cookie only; a held bearer token stays valid to expiry (`routes/auth.ts:35-39`) |
| Session management | **PARTIAL** | Stateless JWT; no session store, no concurrent-session control |
| **Refresh tokens** | **MISSING** | No refresh endpoint, no refresh token issued |
| **Token revocation / denylist** | **MISSING** | Explicitly declined in code comment (`routes/auth.ts:36-37`) |
| **Password reset** | **MISSING** | No endpoint, no token, no email path |
| **Account lockout** | **MISSING** | No lockout; only the IP-scoped login rate limiter |
| **MFA for API login** | **MISSING** | `mfaEnabled` exists on `Identity`/`Asset` as *data*, never as an auth control |
| **Password policy** | **MISSING** | Login schema requires `min(1)`; no complexity rule anywhere; no signup path |
| `cookie-parser` | **NOT USED** | Cookie parsed with a hand-written regex (`auth.ts:17`) |

### ⚠ Finding 8.1 — `secure` flag is never set on the session cookie

`res.cookie(COOKIE_NAME, …, { httpOnly: true, sameSite: "lax" })` — no `secure: true`, no
environment-conditional. Documented as deliberate ("the demo runs over plain http",
`routes/auth.ts:22`). Over HTTPS this would still transmit without the `Secure` attribute.
Blocking for any non-local deployment.

### ⚠ Finding 8.2 — Cookie auth + `credentials: true` with no CSRF defence

`requireAuth` accepts the token from a cookie (`auth.ts:16-18`) and CORS runs with
`credentials: true` (`app.ts:33`). `sameSite: "lax"` blocks cross-site *cookie-bearing*
POSTs from a third-party page, which is the main mitigation here — but there is **no CSRF
token, no double-submit, and no `cookie-parser`**. Risk is currently contained by `lax` +
the single-origin CORS allowlist; it becomes material if `sameSite` is relaxed or a second
origin is added.

---

# Step 9 — RBAC / authorization

Implementation: `requireRole` in `src/middleware/auth.ts:40-55`.

| Aspect | State |
|---|---|
| Roles available | `ADMIN`, `ANALYST`, `VIEWER` (Prisma enum `Role`) |
| **Role hierarchy** | **None.** Flat allowlist — `roles.includes(req.user.role)`. `ADMIN` is not implicitly `ANALYST`; every gate lists roles explicitly |
| Permission model | **None.** No permissions, scopes or capabilities — role name matching only |
| Source of role | The **JWT claim**, not a per-request DB lookup. A role change requires re-login to take effect |
| Read endpoints | All 10 read endpoints are open to **any signed-in role**, including VIEWER |
| Write endpoints | All 6 gated `["ADMIN","ANALYST"]` |
| Import endpoints | All 4 gated `["ADMIN"]` — deliberately narrower, including the read-only template/contract routes (`routes/import.ts:20-26`) |
| Resource-level authz | **None.** No per-record ownership check anywhere |
| Organization isolation | **None.** No tenant concept |
| Admin-only operations | Import only |

### Gate coverage — verified route by route

Every mutating route carries a role gate. No write endpoint relies on the client:

| Route | Gate | Line |
|---|---|---|
| `POST /api/assets` | `canWrite` = ADMIN, ANALYST | `routes/assets.ts:49` |
| `PATCH /api/assets/:id` | `canWrite` | `routes/assets.ts:60` |
| `POST /api/risks/:assetId/recompute` | `canWrite` | `routes/risks.ts:31` |
| `POST /api/vendors` | `canWrite` | `routes/vendors.ts:45` |
| `PATCH /api/vendors/:id` | `canWrite` | `routes/vendors.ts:53` |
| `POST /api/vendors/:id/recompute` | `canWrite` | `routes/vendors.ts:66` |
| `GET /api/import` | `adminOnly` | `routes/import.ts:82` |
| `GET /api/import/:entity/template` | `adminOnly` | `routes/import.ts:105` |
| `POST /api/import/:entity/validate` | `adminOnly` | `routes/import.ts:116` |
| `POST /api/import/:entity` | `adminOnly` | `routes/import.ts:128` |

**No route was found that depends on frontend-only restriction.** Ordering is correct
throughout: `requireAuth` (app level) precedes `requireRole` (router level), so an
anonymous call to a gated route returns **401, not 403** — verified behaviour, and
asserted by `tests/integration/rbac.test.ts`.

### ⚠ Finding 9.1 — VIEWER can read the entire PHI estate

Every read endpoint is open to all authenticated roles, including the full access-grant
register (`/api/access`, which exposes identity names, emails, departments and privilege
flags) and the threat feed. There is no field-level redaction and no data classification in
the response layer. This is consistent with a single-tenant demo, but it means "VIEWER" is
"read everything", not "read a subset".

---

# Step 10 — Risk engine audit

Pure maths: `src/services/riskScoring.ts`. Persistence: `src/services/riskEngine.ts`.
Vendor twin: `src/services/vendorService.ts:recomputeVendorRisk`.

### Exact current formula

```
assertInRange(each of likelihood, impact, exposure, controlGap)   // integer, 1..5 inclusive
raw   = likelihood × impact × exposure × controlGap               // 1..625
score = round( (raw / 625) × 100 × 100 ) / 100                    // 0..100, 2 decimal places
```

`MAX_RAW_SCORE = 625` (`riskScoring.ts:11`). Out-of-range input throws `BadRequestError`
(400), not a silent clamp.

### Band thresholds — upper bounds on the normalised score

| Score | Band |
|---|---|
| ≤ 20 | `LOW` |
| ≤ 40 | `MODERATE` |
| ≤ 60 | `HIGH` |
| ≤ 80 | `CRITICAL` |
| > 80 | `EXTREME` |

The code documents the consequence of a four-factor product: 4/4/4/3 normalises to only
30.72 (`MODERATE`), and `EXTREME` needs a raw product ≥506, i.e. effectively all 5s
(`riskScoring.ts:27-33`).

### Concept presence

| Concept | Present? | Notes |
|---|---|---|
| likelihood / impact / exposure / controlGap | ✅ | Four `Int` columns, 1-5, on `Risk` and `VendorRisk` |
| raw score | ✅ | Internal only — computed, never persisted |
| normalized score | ✅ | `Risk.score` (Float) |
| risk band | ✅ | `Risk.band` (`RiskBand` enum) |
| recomputation | ✅ | Two endpoints |
| persistence | ✅ | Prisma `update` |
| **automatic creation** | ❌ **Does not exist** | see below |
| manual assessment | **PARTIAL** | Only via CSV import — there is no endpoint to submit or edit the four factors |
| **historical tracking** | ❌ **Does not exist** | recompute **overwrites in place** |

### What actually happens, per trigger

| Trigger | Actual behaviour | Evidence |
|---|---|---|
| **1. Asset created** (`POST /api/assets`) | **No risk is created.** `createAsset` does a uniqueness pre-check and a single `asset.create` — no risk logic at all. Asset returns `risk: null` and is absent from `GET /api/risks` | `assetService.ts:110-115` |
| **2. Risk created** | Only via CSV import of the `risks` entity. `score`/`band` are derived server-side by the same `computeRisk`; **no band is accepted from the file** | `importService.ts:300-310` |
| **3. Risk updated** | No endpoint updates the four inputs. They are write-once (import) and thereafter only recomputable | — |
| **4. Risk recomputed** | Loads the **latest** `Risk` row, recomputes from its **stored, unchanged** inputs, and calls `risk.update` on that same row id — changing `score`, `band`, `computedAt`. Returns `previous: { score, band }`. **404s if no risk row exists.** With unchanged inputs the result is identical apart from the timestamp | `riskEngine.ts:20-56` |
| **5. Asset imported** | Same as (1) — **no risk is created.** Imported assets show `risk: null` | `importService.ts:288` (plain `createMany`) |
| **6. Related data changes** (PHI volume, encryption, MFA, flows, access, threats, vendor BAA) | **Nothing.** No trigger, no recalculation, no invalidation. The four factors are human judgements that no other data feeds | no cross-service calls exist |

### ⚠ Finding 10.1 — Recompute cannot change a score, and overwrites history

Because recompute re-reads the *same stored inputs* and writes to the *same row*, it is a
no-op on the numbers by construction — it can only ever change `computedAt`, unless the
inputs were altered by a route that does not exist. Simultaneously, the in-place `update`
means **risk history is destroyed**: there is no prior-score record beyond the transient
`previous` field in the HTTP response. For a compliance product where "risk trend over
time" is a core expectation, this is a significant modelling gap. The `Risk` table has a
`computedAt` index that would support history, but the write path forecloses it.

### ⚠ Finding 10.2 — There is no API path to perform an assessment

The only way a risk record enters the system is CSV import of the `risks` entity, or
seeding. There is no `POST /api/risks` and no endpoint to edit likelihood/impact/exposure/
controlGap. An assessor using the product cannot record an assessment through the API.

### Risk engine unit tests

`src/services/riskScoring.test.ts` — 9 tests, 2 describes, **all passing** (run this
session, no DB). Coverage observed: band boundaries, the 2-dp rounding rule, and
out-of-range rejection. `src/services/flowStatus.test.ts` — 3 tests, all passing.
There are **no unit tests for `riskEngine.ts` itself** (the persistence half); it is
covered indirectly by integration tests, which were not run this session.

---

# Step 11 — CSV import system

Three-layer design: `importSpec.ts` (pure contract) → `importParsing.ts` (pure parsing) →
`importService.ts` (database). This is the most thoroughly engineered subsystem in the
repository.

| Aspect | Actual behaviour | Evidence |
|---|---|---|
| Supported entities | **7**: `assets`, `phi-types`, `data-flows`, `vendors`, `access-grants`, `threats`, `risks` | `importSpec.ts:ENTITY_SLUGS` |
| Template generation | Header + one realistic example row, per entity | `importParsing.ts:templateCsv` |
| Validation | Header check first (reported once against row 1), then per-cell coercion by type: `string`/`int`/`boolean`/`date`/`enum` | `importParsing.ts:parseCsv`, `coerce` |
| Date strictness | Anchored `^\d{4}-\d{2}-\d{2}$` only — refuses `03/04/2026` because it is ambiguous by locale | `importParsing.ts`, `case "date"` |
| Boolean accepted | `true/yes/y/1` and `false/no/n/0`, case-insensitive | `TRUE_VALUES`/`FALSE_VALUES` |
| Line endings | `record_delimiter: ["\r\n","\n","\r"]` — all three explicitly, because auto-detect locks onto the first seen and silently merges mixed-ending files | `importParsing.ts:readRecords` |
| Preview | First **10** parsed rows, shown as **natural keys not resolved ids** so the user can compare against their file | `importService.ts:PREVIEW_ROWS` |
| **Transaction handling** | **Real.** `runImport` wraps analyse + insert in `prisma.$transaction`; the duplicate re-check runs **inside** the transaction's own view, not against a pre-taken snapshot | `importService.ts:322-332` |
| **Rollback behaviour** | All-or-nothing. Any row error ⇒ `imported: 0`, HTTP 400 `IMPORT_VALIDATION_FAILED`, nothing written | `routes/import.ts:133-142` |
| **Partial import** | **Not possible by design** — there is no "import the good rows" mode | same |
| RBAC | ADMIN-only on all four endpoints, including template and contract | `routes/import.ts:20-26` |
| File size limit | 2 MB (`MAX_BYTES`), multer-enforced, `LIMIT_FILE_SIZE` → **413 `FILE_TOO_LARGE`** | `routes/import.ts:12,50-53` |
| File type restriction | Filename must end `.csv` (case-insensitive) → else 400. **Extension only — no MIME or content sniffing** | `routes/import.ts:37-43` |
| File count | 1 (`files: 1`) | `routes/import.ts:33` |
| Storage | `multer.memoryStorage()` — never written to disk | `routes/import.ts:32` |
| **Formula injection (inbound)** | **Protected.** Cells beginning `=`, `+`, `-`, `@`, TAB or CR are **rejected** for string and ref columns. Documented trade-off: a legitimate name starting `-` is refused too | `importParsing.ts:FORMULA_PREFIXES`, `looksLikeFormula` |
| **Formula injection (outbound)** | **Protected.** `escapeCsvValue` prefixes a dangerous value with `'` and quotes/escapes as needed — so generated templates cannot be the attack either | `importParsing.ts:escapeCsvValue` |
| Natural-key handling | Per-entity natural key; refs resolved **case-insensitively** by loading the whole reference table into a `Map` (one query, not N) | `importService.ts:loadRefIndex` |
| Ambiguous refs | `Identity.displayName` duplicates map to `-1` and are reported as ambiguous rather than silently picked | `importService.ts:loadRefIndex` |
| Duplicate — in file | Detected via `naturalKeyOf`, reports *"already used on row N"* | `importParsing.ts:parseCsv` |
| Duplicate — pre-existing | Per-entity existence query; message names the natural key: *"… already exists, matched on name. Import only adds new records."* | `importService.ts:existingRecordErrors` |
| **Upsert / update-on-import** | **Not supported.** Import only adds | same |
| FK validation | Unresolvable ref ⇒ *"No Asset found named X. Create it first, then re-import."*; row is dropped from `resolved` so no half-built row reaches insert | `importService.ts:resolveRefs` |
| Error reporting | `{ row, field, message }`, sorted by row then field; `row` is the **true file line** (header = 1, first record = 2), carried explicitly so dropped rows do not shift later numbers | `importParsing.ts:rowNumbers`, `FIRST_DATA_ROW` |
| Risk band on import | Derived server-side by `computeRisk`; the file cannot supply `score` or `band` | `importService.ts:300-310` |
| Dry run parity | `/validate` and `/import` run the **identical** `analyse` pipeline; validate stops before insert | `importService.ts:analyse` |

### Performance characteristics

- Whole file read into memory as a UTF-8 string (`file.buffer.toString("utf8")`), parsed
  synchronously by `csv-parse/sync`. Bounded by the 2 MB limit.
- Reference tables loaded **whole** per import (`findMany` with no `where`) — one query per
  ref target, not per row. Sound at estate scale; would become a memory concern only if a
  reference table reached hundreds of thousands of rows.
- Insert is a single `createMany` per import.
- **The entire parse + resolve + duplicate-check + insert runs inside one transaction**,
  so a large file holds a write transaction open for its full duration.

### ⚠ Finding 11.1 — `.csv` extension is the only file-type check

`fileFilter` tests `originalname.toLowerCase().endsWith(".csv")` and nothing else — no MIME
check, no content sniffing. A binary or HTML file renamed to `.csv` is accepted by multer
and then fails at parse time with a CSV format error. Low severity (the parser is the real
gate, content is never executed, and files never touch disk), but the check is weaker than
it appears.

---

# Step 12 — Security audit

Code-level review only; no offensive testing performed.

| Control | State | Evidence / notes |
|---|---|---|
| Helmet | ✅ Enabled first, before everything, so headers are present on errors and 429s. `contentSecurityPolicy: false` — deliberate, JSON-only service | `app.ts:23` |
| CORS | ✅ Single origin from `FRONTEND_ORIGIN` env, default `http://localhost:8080`, `credentials: true`. **Not a wildcard** | `app.ts:31-33` |
| Rate limiting — global | ✅ 300 / 15 min, `draft-7` headers | `security.ts:createGlobalLimiter` |
| Rate limiting — login | ✅ 10 / 15 min, **`skipSuccessfulRequests: true`** so only failures count | `security.ts:createLoginLimiter` |
| Limiter as factory not singleton | ✅ Deliberate — a shared instance would make every app in a process draw one budget | `security.ts:28-32` |
| `trust proxy` | ✅ Set to `1` so limiting keys on the real client IP behind one proxy hop | `app.ts:27` |
| Authentication | ✅ See Step 8 |
| Authorization | ✅ See Step 9 |
| Password hashing | ✅ bcrypt cost 10 |
| JWT secret | ✅ **Refuses to start/sign if unset or <16 chars** — no silent default | `authService.ts:37-45` |
| Secrets in repo | ✅ `.env` gitignored; `.env.example` holds key names only. No secret value appears in tracked source | `.gitignore`, inspection |
| Input validation | ✅ Zod on every write; strict CSV coercion | — |
| SQL / ORM injection | ✅ **No raw SQL in `src/` at all.** Zero `$queryRaw`/`$executeRaw` outside test fixtures. All access is parameterised Prisma | grep verified |
| File upload | ✅ Memory only, 2 MB, 1 file, extension check (see Finding 11.1) |
| CSV injection | ✅ **Defended in both directions** — rare and notable | `importParsing.ts` |
| Error leakage | ✅ Stack traces never serialised; generic `INTERNAL_ERROR` message on 500 | `errorHandler.ts` |
| Raw-body redaction | ✅ `withoutRawBody()` strips `err.body` before logging, explicitly because a malformed login body contains a plaintext password | `errorHandler.ts:60-70` |
| Body-parser failures | ✅ Mapped to 400/413/415 rather than 500, and the payload is neither echoed nor logged | `errorHandler.ts:26-40, 85-95` |
| PHI in logs | ✅ **No PHI logged.** Only two startup lines and two error lines exist in the whole codebase | grep of `console.` |
| DB credentials | ✅ From `DATABASE_URL` env only; never logged. Prisma log level is `["error"]` in production, `["warn","error"]` otherwise | `lib/prisma.ts` |
| Cookie `httpOnly` | ✅ | `routes/auth.ts:24` |
| Cookie `sameSite` | ✅ `lax` | `routes/auth.ts:25` |
| **Cookie `secure`** | ❌ **Never set** — Finding 8.1 | `routes/auth.ts:23-27` |
| **CSRF** | ❌ **No protection** — Finding 8.2. Mitigated in practice by `sameSite: lax` + single-origin CORS | — |
| **HTTPS / HSTS** | ⚠ Helmet sets HSTS by default, but the service itself is HTTP-only in this configuration | — |
| **Structured logging** | ❌ None — Finding 12.1 |
| **Env var validation** | ❌ None. `DATABASE_URL` and `JWT_SECRET` fail loudly at use; `PORT`/`FRONTEND_ORIGIN` silently fall back to defaults | — |
| **Dependency scanning** | ❌ No `npm audit` step in CI | `.github/workflows/ci.yml` |

### ⚠ Finding 12.1 — No request logging of any kind

There is no HTTP access log, no request id, no structured logger. The entire logging
surface is four `console` calls: two startup lines (`src/server.ts:9-10`) and two error
lines (`src/middleware/errorHandler.ts:87,102`). Consequences: a failed login leaves **no
trace whatsoever**; a 500 logs a stack with no correlating request, user, route or
timestamp beyond the console's own; there is no way to reconstruct who called what. This
compounds directly with Step 13.

---

# Step 13 — Audit logging

**Verdict: audit logging does not exist in any form.**

| Requirement | Present? | Evidence |
|---|---|---|
| Persistent audit model | ❌ | No `AuditLog`/`AuditEvent`/`ActivityLog` model in `prisma/schema.prisma` (12 models, all inventoried in Step 4) |
| Who performed an action | ❌ | `req.user` is never persisted to any table; no `actorId`, `createdBy`, `performedBy` field on any model (grep → zero) |
| What changed | ❌ | No change record. Updates are in-place Prisma `update` calls |
| When it changed | ❌ **Partially impossible** | No `updatedAt` on **any** model. `createdAt` exists on only 4 of 12 (`User`, `Asset`, `Vendor`, `Identity`) |
| Previous value | ❌ | The only prior-value surface anywhere is the transient `previous: { score, band }` in the recompute HTTP **response** — never stored (`riskEngine.ts:52`) |
| New value | ❌ | not recorded |
| IP / device metadata | ❌ | never captured; `trust proxy` is set for rate limiting only |
| Login events | ❌ | successful login writes nothing |
| Failed authentication | ❌ | **not logged at all** — no console line, no row |
| Administrative actions | ❌ | not recorded |
| Imports | ❌ | **not recorded.** A bulk insert of arbitrary rows leaves no trace of who ran it or what file |
| Exports | n/a | no export functionality exists |
| CRUD operations | ❌ | not recorded |

### ⚠ Finding 13.1 — P0 for the stated product domain

For a platform whose purpose is PHI risk intelligence and HIPAA-adjacent compliance
visibility, the absence of an audit trail is the single largest gap in the system. The
product can tell an organisation who has access to PHI, while itself keeping no record of
who changed that information inside the tool. The missing `updatedAt` columns mean that even
a retrospective reconstruction is impossible from the current data — the information was
never captured.

---

# Step 14 — API / frontend compatibility

`API_REFERENCE.md` (committed 2026-09-21, `53d5456`) is accurate to this commit; it was
produced by executing all 22 endpoints against a live server and cross-checking each
response against the service code.

### Contract facts the frontend must handle

| Area | Contract | Compatibility risk |
|---|---|---|
| Success envelope | Always `{ "data": ... }` | Consistent |
| Error envelope | Always `{ "error": { code, message } }`, `+details[]` on validation, `+report` on failed import | Consistent |
| **Shape inconsistency** | `/api/assets`, `/api/dataflows`, `/api/risks`, `/api/vendors` return `data` = **array**. `/api/access` and `/api/threats` return `data` = **object** `{ summary, grants|threats }` | ⚠ **A client assuming "list endpoints return arrays" breaks on two of them** |
| **`risk` can be `null`** | `GET /api/assets[].risk` is `null` for any never-assessed asset | ⚠ Must be null-guarded. **Currently affects 8 of 16 assets in the dev DB** |
| **List vs detail divergence** | `assets` list `risk` = `{score, band, computedAt}`; asset **detail** `risk` = `{id, likelihood, impact, exposure, controlGap, score, band, computedAt}`. Vendors: list has `assetCount` + `assets: string[]`; detail has `assets: object[]` + `createdAt`, no `assetCount` | ⚠ Two different shapes per entity |
| Foreign keys in responses | `/api/dataflows` returns asset **names** (`source`, `target`, `phiType`), not ids | By design for the Sankey; no id available for linking |
| Enum values | Uppercase snake for domain enums (`CLOUD_STORAGE`, `FALSE_POSITIVE`); **flow `status` is lowercase** (`ok`/`warn`/`violation`) | ⚠ Inconsistent casing convention |
| Dates | ISO 8601 UTC strings out; `YYYY-MM-DD` accepted in | Consistent |
| **Pagination** | **None on any endpoint.** Every list returns the complete set | ⚠ Client-side only |
| **Filtering / search** | **None.** No query parameters are read by any route (`validate({query})` is never used) | ⚠ Client-side only |
| Sorting | Fixed server-side, not client-controllable: assets by `name`; dataflows by `recordsPerDay` desc; risks by `score` desc; vendors by `name`; access by `riskFlagCount` desc then idle; threats by open → severity → recency | ⚠ Cannot be overridden |
| Auth | `Authorization: Bearer` **or** `medguard_token` cookie | Both work |
| `POST /api/auth/login` | Returns token **and** sets cookie | Either strategy viable |
| Anonymous on gated route | **401, not 403** | Client must not treat 401 as "wrong role" |
| Health probe | **`/health`, not `/api/health`** — the latter returns 401 | ⚠ Easy misconfiguration |
| Derived read-only fields | `daysSinceAssessment`, `assessmentOverdue` (>365d), `baaCompliant` (`=== "SIGNED"`), `daysSinceUse`, `flags[]`, `riskFlagCount`, `hoursSinceDetection`, `open` | Computed per request; not persisted |
| Cookie name | `medguard_token` | ⚠ **Will change if Drishti rename proceeds — a breaking change for any client reading it** |

---

# Step 15 — Testing audit

| Item | Value |
|---|---|
| Runner | **Vitest 3.2.7** (not Jest — Finding 2.1) |
| Config | `vitest.config.ts` |
| Test files | **11** |
| Total test cases | **246** (79 unit + 167 integration, by `it()` count) |
| Skipped / todo tests | **0** across all 11 files |
| Coverage configuration | **None** — no `coverage` key, no provider installed |
| HTTP testing | Supertest 7.2.2 against `createApp()` |
| DB isolation | `DATABASE_URL` overridden in `vitest.config.ts` to `medguard_test`; `TEST_DATABASE_URL` honoured if set |
| Safety guard | `tests/setup/globalSetup.ts` **throws** if the target database name does not match `/test/i` — "Refusing to run integration tests against database X" |
| Parallelism | `fileParallelism: false` — integration files share one database |
| Hook timeout | 30 s (raised because fixture truncate+seed genuinely exceeded the 10 s default) |

### Test inventory

| File | Cases | Kind | DB required |
|---|---|---|---|
| `src/services/importParsing.test.ts` | 67 | unit (pure) | ❌ |
| `src/services/riskScoring.test.ts` | 9 | unit (pure) | ❌ |
| `src/services/flowStatus.test.ts` | 3 | unit (pure) | ❌ |
| `tests/integration/import.test.ts` | 41 | integration | ✅ |
| `tests/integration/vendors.test.ts` | 22 | integration | ✅ |
| `tests/integration/routes.test.ts` | 21 | integration | ✅ |
| `tests/integration/rbac.test.ts` | 19 | integration | ✅ |
| `tests/integration/auth.test.ts` | 12 | integration | ✅ |
| `tests/integration/access.test.ts` | 10 | integration | ✅ |
| `tests/integration/threats.test.ts` | 9 | integration | ✅ |
| `tests/integration/security.test.ts` | 8 | integration | ✅ |

(Unit counts by `it()` grep differ slightly from Vitest's runtime count for
`importParsing.test.ts` — 39 `it()` literals expand to 67 executed cases, indicating
table-driven `it.each`-style tests.)

Fixtures: `tests/helpers.ts` — `seedFixture()` builds a deliberately small, exactly-countable
fixture (2 assets, 1 PHI type, 1 flow, 2 risks, 3 users) so assertions can name exact
numbers rather than asserting "> 0". Password hash and login tokens are cached per process
for speed, with a documented justification for why token reuse is safe across resets.

### ⚠ What was and was not run this session

**RUN — unit tests only, zero database contact:**

```
$ npx vitest run --config <out-of-tree config with no globalSetup>
 ✓ src/services/flowStatus.test.ts      (3 tests)
 ✓ src/services/riskScoring.test.ts     (9 tests)
 ✓ src/services/importParsing.test.ts   (67 tests)
 Test Files  3 passed (3)
      Tests  79 passed (79)
```

**NOT RUN — the 167 integration tests.** Reason: `vitest.config.ts` registers
`tests/setup/globalSetup.ts` globally, which executes **`npx prisma migrate deploy`**, and
`tests/helpers.ts:57` executes **`TRUNCATE TABLE … RESTART IDENTITY CASCADE`** on every
`beforeEach`. Both are migration/destructive database operations that this audit forbids —
the prohibition is not qualified by which database is targeted. To run the unit tests
without triggering `globalSetup`, an audit-only Vitest config was written **outside the
repository** (in the session scratchpad); no repository file was added or modified.

For reference, not as a current result: the same 246 tests were executed against this exact
commit on 2026-09-21 and reported 246/246 passing, with one transient
`socket hang up` transport failure in `rbac.test.ts` on one run that did not reproduce
across five subsequent runs. That is prior-session evidence, not a measurement from today.

---

# Step 16 — Build / typecheck / lint

All commands run this session against commit `53d5456`.

| Check | Command | Result |
|---|---|---|
| **TYPECHECK (src)** | `npx tsc --noEmit -p tsconfig.json` | **PASS** (exit 0) |
| **TYPECHECK (tests)** | `npx tsc --noEmit -p tsconfig.test.json` | **PASS** (exit 0) |
| **BUILD** | `npx tsc -p tsconfig.json --outDir <scratchpad>` | **PASS** (exit 0, 49 `.js` files emitted) |
| **LINT** | `npx eslint .` | **PASS** (exit 0, no warnings) |
| **TESTS (unit)** | `npx vitest run --config <out-of-tree>` | **PASS** — 79/79 |
| **TESTS (integration)** | — | **NOT RUN** — prohibited by audit rules (see Step 15) |

No failures to report. The build was emitted to the session scratchpad rather than the
repository's `dist/` so that no repository artifact was altered; `dist/` is gitignored in
any case.

---

# Step 17 — Performance / scalability

### Indexes present

Well covered for the current query shapes: `User.role`; `Asset.type` + unique `name`;
`PHIType.sensitivity`; `AssetPHI.phiTypeId`; `DataFlow` on all three FKs; `Risk` on
`assetId`, `band`, `computedAt`; `Vendor.baaStatus` + unique `name`;
`VendorAssetAccess.assetId`; `VendorRisk` on `vendorId`, `band`; `Identity` on `kind`,
`active`; `AccessGrant` unique `(identityId, assetId)` + `assetId` + `lastUsedAt`;
`Threat` on `assetId`, `severity`, `status`, `detectedAt`.

### Query patterns

| Endpoint | Pattern | Assessment |
|---|---|---|
| `GET /api/assets` | `findMany` + `include: { risks: { orderBy, take: 1 } }` | Prisma issues a correlated fetch for the nested `take: 1` — **one extra query, not N**, but the per-asset latest-risk lookup is the classic shape that degrades with row count |
| `GET /api/assets/:id` | Single `findUnique` with 4 nested includes (phiTypes+phiType, risks, outbound+target, inbound+source) | Bounded, single record |
| `GET /api/dataflows` | `findMany` + 3 `select`-narrowed includes | Efficient — selects only needed columns |
| `GET /api/risks` | `findMany` + `include asset.select(name)` | Efficient |
| `GET /api/vendors` | `findMany` + `assetAccess`, `risks take:1` | Same latest-risk shape |
| `GET /api/access` | `findMany` + `include: { identity: true, asset: select }` — then **all flag computation and sorting in JS** | `identity: true` fetches every identity column; sorting is in-process |
| `GET /api/threats` | `findMany` + asset select — **all summarising, counting and sorting in JS** | in-process |

### Scalability constraints — evidence-based

| Constraint | Evidence | Effect |
|---|---|---|
| **No pagination anywhere** | `take`/`skip`/`cursor` appear only in the two `latestRisk` helpers (`assetService.ts:8`, `vendorService.ts:6`) — never for list responses | Every list endpoint returns the **entire table**; response size grows linearly and unboundedly |
| **No filtering or search** | `validate({ query })` is never used; no route reads `req.query` | All narrowing is client-side, over a full payload |
| **Aggregation in JavaScript, not SQL** | `accessService.ts:84-97`, `threatService.ts:41-50` | Summary counts and sorting load every row into memory first. No `groupBy`/`count` used anywhere |
| **Import holds one transaction for the whole file** | `importService.ts:324` | A 2 MB file's parse, ref-load, duplicate-check and insert all occur inside one write transaction |
| **Reference tables loaded whole per import** | `loadRefIndex` `findMany` with no `where` | Memory scales with the reference table, not the file |
| **No caching** | no cache layer, no memoisation, no Redis | Every request recomputes derived fields |
| **No background jobs** | no queue, no scheduler, no cron | Everything is synchronous in the request path |
| Connection management | ✅ Single global `PrismaClient` with an explicit rationale about `tsx watch` reloads exhausting the pool; graceful `$disconnect` on SIGINT/SIGTERM | Sound |

### Suitability

| Scale | Assessment |
|---|---|
| **Demo-scale (tens of records)** | ✅ Suitable. Current dev DB: 16 assets, 10 flows, 9 grants, 5 threats — all endpoints return in the low tens of milliseconds |
| **Hundreds of records** | ✅ Workable. Payloads grow but stay small; JS-side aggregation is trivial at this size |
| **Thousands of records** | ⚠ Degrades. Unpaginated list responses reach megabytes; `/api/access` and `/api/threats` load and sort every row per request; the assets list does a per-asset latest-risk lookup |
| **Production datasets (10k+)** | ❌ Not suitable without change. Pagination, SQL-side aggregation and server-side filtering are all absent, and the 2 MB/one-transaction import ceiling caps bulk onboarding |

These are technical constraints with file-level evidence, not a product judgement.

---

# Step 18 — Integrations

Exhaustive grep across `package.json` and all of `src/` (excluding the generated Prisma
client) for: `aws-sdk`, `@aws`, `azure`, `googleapis`, `@google-cloud`, `okta`, `entra`,
`msal`, `slack`, `jira`, `datadog`, `sentry`, `fhir`, `hl7`, `cerner`.

| System | Status |
|---|---|
| AWS | **NOT PRESENT** |
| Azure | **NOT PRESENT** |
| GCP | **NOT PRESENT** |
| Okta | **NOT PRESENT** |
| Microsoft Entra | **NOT PRESENT** |
| Google Workspace | **NOT PRESENT** |
| EHR systems (Epic/Cerner/FHIR/HL7) | **NOT PRESENT** — "Epic EHR Core" is a **seed data string**, not an integration |
| Jira | **NOT PRESENT** |
| GitHub | **NOT PRESENT** as a product integration (GitHub Actions is used for CI only) |
| Slack | **NOT PRESENT** |
| Datadog / Sentry / APM | **NOT PRESENT** |
| Supabase / Clerk | **DOCUMENTATION ONLY** — named in comments as a possible future auth provider; `User.externalAuthId` is a deliberate seam for it, currently unused and null everywhere (`prisma/schema.prisma`, `authService.ts:9-13`) |
| Email / SMTP | **NOT PRESENT** |

**The only external system the backend talks to is PostgreSQL.** Every domain concept —
assets, identities, vendors, threats — is populated exclusively by seed or CSV import. There
are no clients, no SDKs, no webhooks, no outbound HTTP calls of any kind in `src/`.

---

# Step 19 — Multi-tenancy

**Verdict: multi-tenancy does not exist. Drishti is single-tenant.**

| Check | Result |
|---|---|
| Organization / Tenant model | ❌ Not in the 12-model schema |
| `orgId` / `organizationId` / `tenantId` field | ❌ **Zero occurrences** in `prisma/schema.prisma` or anywhere in `src/` |
| Organization membership | ❌ `User` has `email`, `role`, credentials — no org link |
| Data scoping | ❌ No service applies a tenant `where` clause; every `findMany` is unscoped |
| Query filters | ❌ None |
| Authorization by tenant | ❌ `requireRole` checks role only |
| Cross-tenant isolation | ❌ Not applicable — there is one implicit tenant |
| Admin cross-org behaviour | ❌ Not applicable |

This is explicit, documented intent rather than an oversight — `prisma/schema.prisma:1-4`:
*"Deliberately minimal: no multi-tenancy. Every asset belongs to the single demo
organisation, so there is no orgId anywhere."*

**Implication for the Drishti positioning:** a platform sold to healthcare *organisations*
currently has no organisation boundary. Introducing one later is a schema-wide change —
every one of the 12 models needs a tenant key, every query needs scoping, and every existing
row needs backfilling. This is the largest structural gap between the current backend and
the stated product.

---

# Step 20 — Branding audit

### Drishti

**Zero occurrences.** Searched case-insensitively for `drishti` across every tracked file
and across the whole working tree excluding `node_modules`/`.git`. No matches.
**The rename has not started in the backend.**

### MedGuard

**89 occurrences across 21 tracked files.**

| File | Count | Nature of the reference |
|---|---|---|
| `DEMO_RUNBOOK.md` | 21 | documentation |
| `README.md` | 10 | documentation |
| `API_REFERENCE.md` | 6 | documentation |
| `.github/workflows/ci.yml` | 5 | **CI Postgres user / password / db name** (`medguard`, `medguard_test`) |
| `.env.example` | 4 | **database names in example URLs** |
| `IMPORT_GUIDE.md` | 4 | documentation |
| `prisma/schema.prisma` | 3 | **header comment + two model doc-comments** |
| `POST_DEMO_BACKLOG.md` | 3 | documentation |
| `BACKEND_QA_REPORT.md` | 2 | documentation |
| `package.json` | 2 | **`"name": "medguard-backend"`, description** |
| `package-lock.json` | 2 | **lockfile package name** |
| `vitest.config.ts` | 2 | **test database name** |
| `src/server.ts` | 2 | **log prefix `[medguard]`** ×2 |
| `src/middleware/auth.ts` | 2 | **cookie name `medguard_token`** |
| `src/middleware/errorHandler.ts` | 2 | **log prefix `[medguard]`** ×2 |
| `src/routes/auth.ts` | 1 | **`COOKIE_NAME = "medguard_token"`** |
| `src/routes/import.ts` | 1 | **template filename `medguard-<entity>-template.csv`** |
| `src/services/importParsing.ts` | 1 | comment |
| `prisma/seed.ts` | 1 | comment |
| `tests/integration/auth.test.ts` | 2 | cookie-name assertion |
| `tests/integration/import.test.ts` | 1 | template-filename assertion |

### Naming inconsistencies and rename blast radius

These are the references that are **functional, not cosmetic** — changing them alters
behaviour or breaks a contract:

| # | Reference | Location | Consequence of renaming |
|---|---|---|---|
| B1 | Cookie `medguard_token` | `routes/auth.ts:15`, `middleware/auth.ts:17` | **Breaking change for any client reading the cookie**; also asserted in `tests/integration/auth.test.ts` |
| B2 | Template filename `medguard-<entity>-template.csv` | `routes/import.ts:108` | User-visible download name; asserted in `tests/integration/import.test.ts` |
| B3 | Log prefix `[medguard]` | `server.ts:9-10`, `errorHandler.ts:87,102` | Any log grep/alert keyed on it |
| B4 | Package name `medguard-backend` | `package.json`, `package-lock.json` | Requires a lockfile update |
| B5 | Database names `medguard_dev` / `medguard_test` | `.env.example`, `vitest.config.ts`, CI | **`globalSetup` guards on `/test/i` in the name, not on "medguard"** — a rename to e.g. `drishti_test` still satisfies the guard, but `drishti_dev` and `drishti_test` must be created and migrated |
| B6 | CI Postgres credentials `medguard` | `.github/workflows/ci.yml` | Internal to CI only |
| B7 | Remote repository name `MedGuard_Shield_Backend` | git remote | Rename is a GitHub-side operation |
| B8 | Schema header + model doc-comments | `prisma/schema.prisma` | **Comment-only — safe**, no migration needed |

**Nothing else in the data model carries the brand**: no table, column or enum value
contains "medguard". A rename therefore needs **no database migration** — only the cookie
name (B1) and template filename (B2) are contract-affecting, and both have tests that will
catch the change.

---

# Step 21 — Current backend gaps

Classified by implementation status, security, correctness and scalability evidence
gathered above. No speculative functionality is included.

### P0 — Blocking / critical

| # | Gap | Evidence |
|---|---|---|
| P0-1 | **No audit logging of any kind** — no audit model, no actor capture, no `updatedAt` on any model, failed logins and imports leave zero trace. Unacceptable for a PHI compliance product | Step 13 |
| P0-2 | **Eight assets in the dev database are inert** — no PHI links, no flows, no risk scores; they appear in the inventory with `risk: null` and are absent from the Risk Register | Finding 22.1 below |
| P0-3 | **Session cookie never sets `secure`** — blocking for any deployment that is not plain-HTTP localhost | Finding 8.1 |
| P0-4 | **No multi-tenancy** while the product is positioned for healthcare organisations; retrofitting touches all 12 models and every query | Step 19 |

### P1 — Important

| # | Gap | Evidence |
|---|---|---|
| P1-1 | **No API path to perform a risk assessment.** The four factors can only enter by CSV import; recompute cannot change them | Finding 10.2 |
| P1-2 | **Risk history is destroyed on recompute** (in-place update); no trend data is retained | Finding 10.1 |
| P1-3 | **No request logging / observability** — no access log, request id, or structured logger | Finding 12.1 |
| P1-4 | **No DELETE endpoints for any entity** — data entering by import cannot be removed through the API; correcting a bad import requires direct SQL | Step 7 |
| P1-5 | **No pagination, filtering or sorting controls** on any list endpoint | Step 17 |
| P1-6 | **Non-import writes are not transactional**; duplicate handling is a TOCTOU read-then-write whose P2002 is untranslated and surfaces as a 500 | Finding 7.1 |
| P1-7 | **No token revocation and no refresh flow** — a leaked token is valid for its full 8 hours | Step 8 |
| P1-8 | **No CSRF defence** while cookie auth + `credentials: true` are enabled | Finding 8.2 |
| P1-9 | **`samples/medguard_assets_sample_100.csv` cannot be imported** — 19 of 20 `type` values violate the `AssetType` enum; all-or-nothing import means zero rows land | Finding 1.1 |
| P1-10 | **`Risk` / `VendorRisk` / `DataFlow` lack DB-level uniqueness** on the keys the application treats as unique | Findings 4.1, 4.2 |
| P1-11 | **`main` is 1 commit ahead of `origin/main`** — `API_REFERENCE.md` exists only locally | Step 1 |
| P1-12 | **No `Control` concept exists** despite "Control" sitting in the stated Asset→PHI→Identity→Vendor→**Control**→Risk model | Step 6 |

### P2 — Improvements

| # | Gap |
|---|---|
| P2-1 | No `updatedAt`/`createdAt` on 8 of 12 models (prerequisite for P0-1) |
| P2-2 | No OpenAPI/Swagger — the contract is hand-maintained Markdown |
| P2-3 | No test coverage instrumentation configured |
| P2-4 | No env-var schema validation; `PORT`/`FRONTEND_ORIGIN` fail silently to defaults |
| P2-5 | No `npm audit`/dependency scanning in CI |
| P2-6 | Upload type check is extension-only (Finding 11.1) |
| P2-7 | Response-shape inconsistencies: two "list" endpoints return objects; list vs detail `risk`/`assets` shapes differ; flow `status` is lowercase while every other enum is uppercase |
| P2-8 | Aggregation done in JavaScript rather than SQL (`/api/access`, `/api/threats`) |
| P2-9 | Zod schemas defined inline per route rather than in a shared validators module |
| P2-10 | Handlers re-`parse()` schemas already parsed by `validate()` |
| P2-11 | No `riskEngine.ts` unit tests (persistence half untested outside integration) |
| P2-12 | `samples/.DS_Store` is untracked clutter |

### P3 — Future capabilities

| # | Capability |
|---|---|
| P3-1 | Real integrations (cloud, EHR/FHIR, identity providers) — currently zero |
| P3-2 | Export endpoints (none exist) |
| P3-3 | Threat status transitions / workflow (threats are read-only) |
| P3-4 | Remediation and policy modules (not modelled) |
| P3-5 | User management, password reset, MFA on API login |
| P3-6 | Background jobs, caching, scheduled rescoring |
| P3-7 | Automatic risk derivation from control data rather than manual 1-5 judgement |
| P3-8 | Risk trend / history storage |

---

# BACKEND CURRENT STATE

### 1. Current architecture

Node 20+ (running v26.7.0) / Express 5.2.1 / TypeScript 5.9.3 strict / Prisma 7.10.0 with
the `pg` driver adapter / PostgreSQL. ESM throughout. **Four layers, not five**: routes →
services → Prisma → Postgres. There is **no controller layer and no repository layer**;
route handlers call services directly and services call Prisma directly. A consistent
pure-vs-impure split (`riskScoring`/`riskEngine`, `flowStatus`/`dataFlowService`,
`importParsing`/`importService`) makes the business rules unit-testable without a database.
`createApp()` is a factory, which is what lets every integration test build an isolated app.

### 2. Current database state

12 models, 9 enums, 4 additive migrations (latest 2026-09-12), no destructive SQL in any
migration, schema and migrations consistent at file level. No tenancy fields, no audit
fields, no soft delete, no `updatedAt` on any model, `createdAt` on only 4 of 12.

**The live dev database changed since yesterday**: all four migrations were re-applied on
**2026-09-22**, and it now holds **16 assets where `prisma/seed.ts` (unchanged since
2026-09-12) defines 8**.

### 3. Current API surface

**22 endpoints**, unchanged in count and shape from the documented baseline. 10 reads open
to any signed-in role, 6 writes gated ADMIN/ANALYST, 4 import endpoints gated ADMIN, 2
public auth routes, 1 public health route. **No DELETE, no export, no PHI-type, identity,
user, settings, audit, policy, control or AI endpoints.**

### 4. Authentication status

**IMPLEMENTED and sound for its scope.** Local email+password, bcrypt(10), HS256 JWT with
`{id,email,role}`, 8-hour TTL, dual Bearer/cookie transport, secret length enforced at use,
user-enumeration resistant. **MISSING**: refresh, revocation, password reset, lockout, MFA,
password policy, `secure` cookie flag.

### 5. Authorization / RBAC status

**IMPLEMENTED.** Three flat roles, no hierarchy, no permission model. Every mutating route
carries an explicit `requireRole`; **no route relies on frontend-only restriction**; 401
correctly precedes 403. **MISSING**: resource-level and organization-level authorization;
all reads are all-or-nothing.

### 6. Risk engine status

**IMPLEMENTED but narrower than the documented model.** Formula is
`(l×i×e×c)/625×100`, 2 dp, five bands, 1-5 inputs validated. **Risk is never created
automatically** — not on asset create, not on asset import. **Recompute cannot change a
score** (it re-reads the same stored inputs) and **overwrites the row in place, destroying
history**. There is **no API to record or edit an assessment**; import is the only path in.
9 unit tests passing.

### 7. Import system status

**IMPLEMENTED, and the strongest subsystem in the codebase.** 7 entities, template
generation, dry-run/real parity through one shared pipeline, genuine `$transaction`
all-or-nothing commit with the duplicate re-check inside the transaction, natural-key FK
resolution with ambiguity detection, in-file and pre-existing duplicate detection,
true-file-line error reporting, 2 MB/1-file memory-only uploads, and **CSV formula-injection
defence in both directions**. Import only adds — no upsert, no partial import.

### 8. Security status

**Good for a single-tenant demo, with two deployment blockers.** Helmet first, single-origin
CORS, two-tier rate limiting with a factory pattern, zero raw SQL, parameterised Prisma
throughout, no PHI in logs, stack traces never serialised, raw request bodies actively
redacted before logging because a malformed login carries a plaintext password. **Blockers**:
cookie `secure` never set; no CSRF defence alongside cookie auth + `credentials: true`.
**Absent**: request logging, env validation, dependency scanning.

### 9. Audit logging status

**DOES NOT EXIST.** No model, no actor capture, no before/after values, no login or import
records, no IP metadata. Missing `updatedAt` columns make retrospective reconstruction
impossible. This is the most serious gap relative to the product's stated purpose.

### 10. Testing status

**246 tests in 11 files, 0 skipped, no coverage configured.** This session ran **79 unit
tests — all passing**, with zero database contact. The **167 integration tests were NOT run**
because their setup executes `prisma migrate deploy` and `TRUNCATE`, both prohibited here.
Typecheck (both projects), build and lint all **PASS**.

### 11. Integration status

**NONE.** No AWS, Azure, GCP, Okta, Entra, Google Workspace, EHR/FHIR/HL7, Jira, Slack,
Datadog or Sentry. The only external system is PostgreSQL. Supabase/Clerk appear as
**documentation-only** future options with one unused seam (`User.externalAuthId`).

### 12. Multi-tenancy status

**DOES NOT EXIST**, by explicit documented decision. No organization model, no tenant field
anywhere, no query scoping.

### 13. Branding status

**Rename has not begun. Zero "Drishti" references anywhere.** 89 "MedGuard" references
across 21 files. Only two are contract-affecting — the `medguard_token` cookie and the
`medguard-*-template.csv` download name — and both are covered by existing tests. **No
database object carries the brand, so a rename needs no migration.**

### 14. Major technical gaps

Audit logging (P0) · inert imported assets in the demo data (P0) · insecure cookie flag
(P0) · no multi-tenancy (P0) · no assessment API and no risk history (P1) · no observability
(P1) · no DELETE (P1) · no pagination/filtering (P1) · non-transactional writes with a
TOCTOU duplicate check (P1) · no revocation/refresh (P1) · no CSRF (P1) · unusable sample
CSV (P1) · missing DB-level uniqueness (P1) · unpushed commit (P1) · no `Control` model
despite the stated conceptual chain (P1).

### 15. Unknown / unverified areas

Stated explicitly rather than assumed:

1. **Integration test results as of today** — not run (prohibited). Last known: 246/246 on 2026-09-21.
2. **Prisma drift detection** — `prisma migrate diff`/`migrate status` not run; schema↔migration sync inferred from file contents and history only.
3. **Who re-migrated and reseeded `medguard_dev` on 2026-09-22, and how assets 9–16 were created.** The evidence (identical `createdAt` to the millisecond across all eight) indicates a single `createMany`, i.e. a CSV import — but the actor is unknowable because **no audit log exists**. This is P0-1 demonstrating itself.
4. **Whether `samples/medguard_assets_sample_100.csv` was ever import-attempted** — none of its asset names are present in the database, and no log would record a failed attempt.
5. **Runtime behaviour under concurrency** — the TOCTOU duplicate window and the missing DB uniqueness were identified by reading code, not by load testing.
6. **Production/staging environments** — none inspected; only the local `medguard_dev` and the `medguard_test` database exist on this machine.
7. **Frontend repository** — out of scope; contract risks in Step 14 are stated from the backend side only.
8. **`origin` branch contents beyond tip metadata** — no fetch was performed, so remote state is as of the last local fetch.

---

# BACKEND API MATRIX

| Method | Endpoint | Auth | Role | DB | Tested | Status |
|---|---|---|---|---|---|---|
| GET | `/health` | ❌ | — | ❌ | ✅ integration | Live |
| POST | `/api/auth/login` | ❌ | — | ✅ read | ✅ `auth`, `security` | Live |
| POST | `/api/auth/logout` | ❌ | — | ❌ | ✅ `auth` | Live |
| GET | `/api/auth/me` | ✅ | any | ❌ | ✅ `auth`, `routes` | Live |
| GET | `/api/assets` | ✅ | any | ✅ read | ✅ `routes` | Live |
| GET | `/api/assets/:id` | ✅ | any | ✅ read | ✅ `routes` | Live |
| POST | `/api/assets` | ✅ | ADMIN, ANALYST | ✅ write | ✅ `rbac` | Live |
| PATCH | `/api/assets/:id` | ✅ | ADMIN, ANALYST | ✅ write | ✅ `rbac` | Live |
| GET | `/api/dataflows` | ✅ | any | ✅ read | ✅ `routes` | Live |
| GET | `/api/risks` | ✅ | any | ✅ read | ✅ `routes` | Live |
| POST | `/api/risks/:assetId/recompute` | ✅ | ADMIN, ANALYST | ✅ write | ✅ `rbac`, `routes` | Live |
| GET | `/api/vendors` | ✅ | any | ✅ read | ✅ `vendors` | Live |
| GET | `/api/vendors/:id` | ✅ | any | ✅ read | ✅ `vendors` | Live |
| POST | `/api/vendors` | ✅ | ADMIN, ANALYST | ✅ write | ✅ `vendors` | Live |
| PATCH | `/api/vendors/:id` | ✅ | ADMIN, ANALYST | ✅ write | ✅ `vendors` | Live |
| POST | `/api/vendors/:id/recompute` | ✅ | ADMIN, ANALYST | ✅ write | ✅ `vendors` | Live |
| GET | `/api/access` | ✅ | any | ✅ read | ✅ `access` | Live |
| GET | `/api/threats` | ✅ | any | ✅ read | ✅ `threats` | Live |
| GET | `/api/import` | ✅ | **ADMIN** | ❌ | ✅ `import` | Live |
| GET | `/api/import/:entity/template` | ✅ | **ADMIN** | ❌ | ✅ `import` ×7 | Live |
| POST | `/api/import/:entity/validate` | ✅ | **ADMIN** | ✅ read | ✅ `import` | Live |
| POST | `/api/import/:entity` | ✅ | **ADMIN** | ✅ **transactional write** | ✅ `import` ×7 | Live |

"Tested" reflects the test files that exercise each endpoint at this commit; those
integration tests were **not executed in this session** (Step 15).

---

# DATABASE MODEL MATRIX

| Model | Exists | Used | Relationships | Tenant Scoped | Audit Fields | Notes |
|---|---|---|---|---|---|---|
| `User` | ✅ | ✅ auth only | none | ❌ | `createdAt` only | No user-management endpoint; `externalAuthId` unused |
| `Asset` | ✅ | ✅ heavily | 7 | ❌ | `createdAt` only | Full CRU; no delete |
| `PHIType` | ✅ | ⚠ partial | 2 | ❌ | **none** | Import-only; no REST endpoint |
| `AssetPHI` | ✅ | ⚠ read-only | 2 | ❌ | **none** | No write path outside seed |
| `DataFlow` | ✅ | ✅ | 3 | ❌ | **none** | No `@@unique` on natural key |
| `Risk` | ✅ | ✅ | 1 | ❌ | `computedAt` (overwritten) | **No `@@unique` on assetId; history destroyed on recompute** |
| `Vendor` | ✅ | ✅ | 2 | ❌ | `createdAt` only | Full CRU; no delete |
| `VendorAssetAccess` | ✅ | ⚠ read-only | 2 | ❌ | `grantedAt` | No write path outside seed |
| `VendorRisk` | ✅ | ⚠ partial | 1 | ❌ | `computedAt` (overwritten) | **No create path at all** |
| `Identity` | ✅ | ⚠ read-only | 1 | ❌ | `createdAt` only | No endpoint; `displayName` not unique but used as import key |
| `AccessGrant` | ✅ | ✅ | 2 | ❌ | `grantedAt`, `lastUsedAt` | `@@unique([identityId, assetId])` ✅ |
| `Threat` | ✅ | ✅ | 1 | ❌ | `detectedAt`, `resolvedAt` | Read-only via API; no status transition |
| **`AuditLog`** | ❌ | — | — | — | — | **Does not exist** |
| **`Organization`** | ❌ | — | — | — | — | **Does not exist** |
| **`Control`** | ❌ | — | — | — | — | **Does not exist** despite the stated conceptual model |
| **`Role`** | ⚠ | ✅ | — | — | — | Exists as an **enum**, not a model |

---

# BACKEND → FRONTEND CONTRACT

What a client must rely on, all verified against source at this commit:

1. **Envelopes.** Success is always `{ data }`. Failure is always
   `{ error: { code, message } }`, plus `details[]` for `VALIDATION_ERROR` and `report` for
   `IMPORT_VALIDATION_FAILED`. 14 error codes; see `API_REFERENCE.md`.
2. **`data` is not always an array.** Arrays for assets/dataflows/risks/vendors; **objects**
   `{ summary, grants }` and `{ summary, threats }` for `/api/access` and `/api/threats`.
3. **`risk` is nullable** on assets and vendors, and a never-assessed asset is **absent
   entirely** from `/api/risks`. Currently true for 8 of 16 assets in the dev database.
4. **List and detail shapes differ** for both assets and vendors — detail carries the four
   1-5 risk factors and (vendors) full asset objects; list does not.
5. **Auth**: `Authorization: Bearer <token>` or the `medguard_token` cookie. 8-hour TTL, no
   refresh. Login returns the token *and* sets the cookie.
6. **401 vs 403**: anonymous on a role-gated route yields **401**, never 403.
7. **Health probe is `/health`**, not `/api/health` (which 401s).
8. **No pagination, filtering or sorting parameters exist.** Lists are complete and
   server-sorted by a fixed rule per endpoint.
9. **Data flows reference assets by name**, not id.
10. **Enum casing is not uniform**: domain enums are UPPER_SNAKE; flow `status` is
    lowercase `ok`/`warn`/`violation`.
11. **Derived fields are computed per request, never stored**: `daysSinceAssessment`,
    `assessmentOverdue` (>365 days), `baaCompliant` (`baaStatus === "SIGNED"`),
    `daysSinceUse`, `flags[]`, `riskFlagCount`, `hoursSinceDetection`, `open`.
12. **Writes require ADMIN or ANALYST; all four import endpoints require ADMIN.**
13. **Imports are all-or-nothing** and return `201` with `imported: n`, or `400` with the
    full failure report.
14. **Rename risk**: the cookie name and CSV template filename both embed "medguard".

---

# EVIDENCE

Every major conclusion, with its source location.

| Conclusion | File | Symbol / location |
|---|---|---|
| 22 endpoints, auth gate placement | `src/app.ts` | `createApp()`, lines 23-60 |
| `/api` gate precedes all domain routers | `src/app.ts` | line 49 `app.use("/api", requireAuth)` |
| Health is public and outside `/api` | `src/app.ts` | line 39 |
| Dual Bearer/cookie token extraction | `src/middleware/auth.ts` | `extractToken()` lines 12-19 |
| Flat role allowlist, no hierarchy | `src/middleware/auth.ts` | `requireRole()` lines 45-55 |
| JWT claims, 8-hour TTL, secret guard | `src/services/authService.ts` | `TOKEN_TTL_SECONDS:25`, `signingSecret():37-45`, `login():51` |
| User-enumeration resistance | `src/services/authService.ts` | lines 56-61 |
| Cookie lacks `secure` | `src/routes/auth.ts` | lines 23-27 |
| Logout cannot revoke a bearer token | `src/routes/auth.ts` | lines 35-39 |
| Risk formula and bands | `src/services/riskScoring.ts` | `MAX_RAW_SCORE:11`, `BAND_UPPER_BOUNDS:34-39`, `computeRisk():60-77` |
| Recompute is in-place, 404s without a prior row | `src/services/riskEngine.ts` | `recomputeAssetRisk()` lines 20-56 |
| Vendor recompute mirrors it | `src/services/vendorService.ts` | `recomputeVendorRisk()` |
| Asset create does not create a risk | `src/services/assetService.ts` | `createAsset()` lines 110-115 |
| Asset import does not create a risk | `src/services/importService.ts` | `insertRows()` line 288 |
| Latest-risk-wins read pattern | `src/services/assetService.ts` | `latestRisk` lines 5-9 |
| Import is transactional, re-checks inside the tx | `src/services/importService.ts` | `runImport()` lines 322-332 |
| Shared validate/import pipeline | `src/services/importService.ts` | `analyse()` |
| Ref resolution, ambiguity → `-1` | `src/services/importService.ts` | `loadRefIndex()`, `resolveRefs()` |
| Pre-existing duplicate detection per entity | `src/services/importService.ts` | `existingRecordErrors()` |
| Risk score derived on import, never read from file | `src/services/importService.ts` | lines 300-310 |
| CSV formula injection defence (in and out) | `src/services/importParsing.ts` | `FORMULA_PREFIXES`, `looksLikeFormula()`, `escapeCsvValue()` |
| True file line numbers preserved | `src/services/importParsing.ts` | `rowNumbers`, `FIRST_DATA_ROW` |
| Mixed line-ending handling | `src/services/importParsing.ts` | `readRecords()` `record_delimiter` |
| Strict date shape | `src/services/importParsing.ts` | `coerce()` `case "date"` |
| ADMIN-only import, 2 MB, `.csv` only, memory storage | `src/routes/import.ts` | lines 12, 20-26, 32-43, 50-53 |
| 7 import entities and their contracts | `src/services/importSpec.ts` | `ENTITY_SLUGS`, `ENTITY_SPECS` |
| Single error→response boundary; no stack leakage | `src/middleware/errorHandler.ts` | `errorHandler` lines 72-104 |
| Raw body redacted before logging | `src/middleware/errorHandler.ts` | `withoutRawBody()` lines 60-70 |
| P2025→404; **no P2002 mapping** | `src/middleware/errorHandler.ts` | line 97 |
| TOCTOU duplicate check | `src/services/assetService.ts` | lines 110-115, 118-128 |
| Two-tier rate limiting, factory not singleton | `src/middleware/security.ts` | `createGlobalLimiter()`, `createLoginLimiter()` |
| Validate middleware mutates the request | `src/middleware/validate.ts` | lines 17-22 |
| Prisma singleton + driver adapter | `src/lib/prisma.ts` | whole file |
| Graceful shutdown | `src/server.ts` | lines 13-20 |
| Log prefix `[medguard]`, only 4 console calls | `src/server.ts:9-10`, `src/middleware/errorHandler.ts:87,102` | — |
| No multi-tenancy, stated as intent | `prisma/schema.prisma` | header lines 1-4 |
| 12 models, cascade/restrict rules | `prisma/schema.prisma` | model blocks |
| No `updatedAt` on any model | `prisma/schema.prisma` | grep → zero |
| 4 additive migrations, none destructive | `prisma/migrations/` | 4 directories, `migration_lock.toml` |
| Dev DB re-migrated 2026-09-22 | `medguard_dev._prisma_migrations` | read-only `SELECT` |
| Seed defines 8 assets; DB holds 16 | `prisma/seed.ts` `ASSETS` (unchanged since 2026-09-12) vs `SELECT * FROM "Asset"` | — |
| Assets 9-16 have 0 PHI, 0 flows, 0 risks, identical `createdAt` | `medguard_dev` | read-only join query |
| Sample CSV violates the AssetType enum | `samples/medguard_assets_sample_100.csv` | 19 of 20 `type` values invalid |
| Test DB guard | `tests/setup/globalSetup.ts` | `/test/i` name check |
| Fixture truncates every table | `tests/helpers.ts` | `resetDatabase()` line 57 |
| Test env override to `medguard_test` | `vitest.config.ts` | `TEST_ENV` |
| Vitest not Jest | `package.json` | `"test": "vitest run"`; no Jest dependency |
| No DELETE anywhere | `src/routes/`, `src/` | grep `.delete(`/`deleteMany` → zero |
| No raw SQL in `src/` | `src/` | grep `$queryRaw`/`$executeRaw` → zero |
| No integrations | `package.json`, `src/` | grep of 14 vendor SDK patterns → zero |
| Zero "Drishti" references | whole tree | case-insensitive grep → zero |
| 89 "MedGuard" references in 21 files | tracked files | per-file counts in Step 20 |

---

### ⚠ Finding 22.1 — The demo database contains eight inert assets (P0-2)

The most consequential *current-state* fact, and the reason it leads this report.

`prisma/seed.ts` — unchanged since 2026-09-12 — defines **8** assets. The database holds
**16**. Read-only evidence:

| id | name | created | PHI links | flows | risks |
|---|---|---|---|---|---|
| 1-8 | seeded set (`Patient Portal` … `Insurance Claims Gateway`) | 09:58:44 | 1-3 each | 1-6 each | **1 each** |
| 9 | Cardiology PACS | 09:59:47 | 0 | 0 | **0** |
| 10 | Oncology Registry | 09:59:47 | 0 | 0 | **0** |
| 11 | Telehealth Gateway | 09:59:47 | 0 | 0 | **0** |
| 12 | Maternity Records | 09:59:47 | 0 | 0 | **0** |
| 13 | Population Health Warehouse | 09:59:47 | 0 | 0 | **0** |
| 14 | Referral Exchange | 09:59:47 | 0 | 0 | **0** |
| 15 | Genomics Pipeline | 09:59:47 | 0 | 0 | **0** |
| 16 | Emergency Triage Board | 09:59:47 | 0 | 0 | **0** |

All eight share a `createdAt` identical to the millisecond — the signature of a single
`createMany`, i.e. **a CSV import**, one minute after the seed ran. None of their names
appear in `samples/medguard_assets_sample_100.csv`, so they came from a different file.

**Observable consequences, all directly from the code paths audited above:**

- `GET /api/assets` returns 16 assets, **8 with `risk: null`** (`assetService.ts:29`).
- `GET /api/risks` returns **8 rows, not 16** — unassessed assets are absent entirely.
- `POST /api/risks/:assetId/recompute` **404s** for all of ids 9-16 with
  *"No risk record exists for asset N"* (`riskEngine.ts:32`) — recompute cannot create a
  first assessment.
- The only way to give them a score is a `risks` CSV import; **no API endpoint can do it**
  (Finding 10.2).
- They contribute no PHI locations and no flows, so they are invisible to the Sankey and to
  every PHI-movement view while still inflating the asset count.

This is exactly the behaviour `DEMO_RUNBOOK.md:306` warns about
(*"If you import an asset live: it will not appear in the Risk Register"*) — now present in
the data rather than hypothetical. **Not a code defect**; a data-state issue requiring a
decision about whether those eight assets should be scored, linked or removed before any
demonstration.

---

*End of audit. No source file, schema, migration, dependency, configuration, database row or
Git object was modified in producing this report. The only file written is this one.*
