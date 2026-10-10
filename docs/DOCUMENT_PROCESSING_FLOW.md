# Document / Data Import Pipeline — Verified Trace

This document maps the real "import" pipeline in Drishti/MedGuard Shield, built
entirely by reading the code listed below. There is no document-processing
pipeline in the sense of OCR/PDF/scanned-document ingestion — the system
imports **structured CSV data** (asset inventory, PHI types, data flows,
vendors, access grants, threats, risk assessments). Every claim below cites
`path:line`.

Repo: `MedGuard_Shield_Backend` (this IS the Drishti backend) + `Drishti`
(frontend). Branch: `demo/ceo-walkthrough`.

## Mermaid sequence diagram

```mermaid
sequenceDiagram
    actor User
    participant UI as ImportData.tsx (frontend)
    participant Hook as useImport.ts hooks
    participant API as apiClient.apiUpload
    participant MW as Express middleware chain
    participant Route as routes/import.ts
    participant Parse as importParsing.ts (csv-parse)
    participant Svc as importService.ts
    participant DB as Prisma / Postgres
    participant Audit as auditService.ts

    User->>UI: picks entity + drops/selects .csv (<=2MB)
    UI->>UI: client checks .csv extension & 2MB size
    UI->>Hook: validate.run(file)  (fires on selection)
    Hook->>API: POST /api/import/:entity/validate (multipart, Bearer header)
    API->>MW: helmet, rate limiter, CORS, express.json (not applied to multipart), requireAuth, requirePermission("import:execute")
    MW->>Route: uploadCsv (multer memoryStorage, 2MB/1 file limit, .csv filename filter)
    Route->>Svc: validateImport(ctx, spec, csvText)
    Svc->>Parse: parseCsv(spec, text) — csv-parse/sync, header+type+bounds checks
    Svc->>DB: loadRefIndex() reads Asset/PHIType/Identity scoped to organizationId (read-only)
    Svc->>DB: existingRecordErrors() reads for natural-key duplicates (read-only)
    Svc-->>Route: ImportReport {valid, totalRows, errors, preview}
    Route-->>Hook: 200 {data: report}
    Hook-->>UI: render ImportPreviewTable or ImportErrorTable

    User->>UI: clicks "Confirm Import"
    UI->>Hook: commit.run(file)
    Hook->>API: POST /api/import/:entity (same multipart, same auth)
    API->>MW: same middleware chain
    MW->>Route: uploadCsv
    Route->>Audit: recordAudit IMPORT_STARTED
    Route->>Svc: runImport(ctx, spec, csvText)
    Svc->>DB: prisma.$transaction: re-run parseCsv + resolveRefs + existingRecordErrors against the transaction's own view
    alt invalid
        Svc-->>Route: {valid:false, errors, imported:0}
        Route->>Audit: recordAudit IMPORT_FAILED
        Route-->>Hook: 400 {error:{code, message, report}}
    else valid
        Svc->>DB: createMany on the target Prisma model, organizationId stamped server-side
        opt entity == risks
            Svc->>DB: computeRisk() scores row; riskHistory.createMany with reason IMPORTED
        end
        Svc-->>Route: {valid:true, imported, preview}
        Route->>Audit: recordAudit IMPORT_COMPLETED
        Route-->>Hook: 201 {data: result}
    end
    Hook->>Hook: invalidate react-query keys (assets, risks, dataFlows, vendors, access, threats)
    UI-->>User: success summary + "view X" link, or per-row error table
```

## Numbered step table

| # | Step | path:line |
|---|------|-----------|
| 1 | Frontend page: entity picker, drag/drop zone, client-side `.csv` extension check and 2MB size check | `Drishti/src/pages/ImportData.tsx:14-15` (MAX_BYTES), `:117-128` (onPick validation) |
| 2 | File auto-validates on selection via dry-run hook; commit only on explicit button click | `Drishti/src/pages/ImportData.tsx:130-141` |
| 3 | Preview/error tables rendered from the server's `ImportReport` | `Drishti/src/pages/ImportData.tsx:302-335`, component at `Drishti/src/components/ImportTables.tsx` |
| 4 | Frontend hooks: `useValidateImport` → `POST /api/import/:entity/validate`; `useRunImport` → `POST /api/import/:entity`; react-query cache invalidation on successful commit | `Drishti/src/hooks/useImport.ts:116-137` |
| 5 | Upload transport: `fetch` with multipart `FormData`, `Authorization: Bearer <token>` header, `credentials: "omit"` (no cookies sent on this call) | `Drishti/src/lib/apiClient.ts:299-313`, `authHeaders` at `:267-274` |
| 6 | Backend middleware chain before any route: helmet, global rate limiter (300 req / 15 min, env `isTest` relaxes to 1000), CORS, `express.json({limit:"100kb"})` (does not constrain multipart bodies — multer handles those separately), then `requireAuth` mounted on all of `/api` | `MedGuard_Shield_Backend/src/app.ts:56,62,74,79,121-127` |
| 7 | `requireAuth`: extracts Bearer token or `drishti_token`/legacy `medguard_token` cookie, verifies JWT, sets `req.user`/`req.ctx` (tenant context carries `organizationId` from the signed token only — never from path/query/body) | `MedGuard_Shield_Backend/src/middleware/auth.ts:58-72` |
| 8 | Import-specific permission gate: both `GET /api/import` (contract) and `POST /api/import/:entity[/validate]` require permission `import:execute` / `import:read`, which only role `ADMIN` holds (not `ANALYST`) | `MedGuard_Shield_Backend/src/routes/import.ts:23-24`, grant matrix at `MedGuard_Shield_Backend/src/lib/permissions.ts:55,98` |
| 9 | Upload handling: `multer.memoryStorage()`, 2MB file size limit, 1 file max, filename must end `.csv`; multer errors translated to typed HTTP errors (413 for oversize) | `MedGuard_Shield_Backend/src/routes/import.ts:12-14,31-65` |
| 10 | Entity resolution: `:entity` slug matched against 7 supported specs (`assets`, `phi-types`, `data-flows`, `vendors`, `access-grants`, `threats`, `risks`); unknown slug → 404 listing supported entities | `MedGuard_Shield_Backend/src/routes/import.ts:68-77`, specs at `MedGuard_Shield_Backend/src/services/importSpec.ts:64-218` |
| 11 | CSV parsing: `csv-parse/sync`, `columns:true`, `trim:true`, BOM-aware, explicit CRLF/LF/CR delimiter handling, `relax_column_count:false` | `MedGuard_Shield_Backend/src/services/importParsing.ts:1,78-96` |
| 12 | Header validation (missing required / unknown columns) checked once against row 1 before any row-level work | `MedGuard_Shield_Backend/src/services/importParsing.ts:103-125` |
| 13 | Per-cell coercion/validation: required-blank check, formula-injection guard (`=`,`+`,`-`,`@`,tab,CR prefixes rejected on string/ref columns), then type-specific rules for `string` (maxLength), `int` (regex + min/max), `boolean` (yes/no/1/0 variants), `date` (strict `YYYY-MM-DD`), `enum` (must be in allowed value list) | `MedGuard_Shield_Backend/src/services/importParsing.ts:128-205` |
| 14 | In-file duplicate detection by natural key (e.g. `name` for assets; `sourceAssetName+targetAssetName+phiTypeName` for data-flows) | `MedGuard_Shield_Backend/src/services/importParsing.ts:208-278`, natural keys declared per entity in `importSpec.ts` (e.g. `:68-69`, `:104-105`) |
| 15 | Foreign-key resolution: natural-key columns (asset/PHI-type/identity names) resolved to ids via a single `findMany` per ref target, scoped to `organizationId` via `scope(ctx)`, case-insensitive match; ambiguous identity names mapped to a sentinel and reported, not silently resolved | `MedGuard_Shield_Backend/src/services/importService.ts:40-70,82-142` |
| 16 | Existing-record (duplicate-against-DB) check, per entity, scoped to the caller's organization | `MedGuard_Shield_Backend/src/services/importService.ts:148-242` |
| 17 | `/validate` endpoint runs the full pipeline read-only (`prisma`, no transaction) and returns the report without writing | `MedGuard_Shield_Backend/src/services/importService.ts:290-297`, route at `MedGuard_Shield_Backend/src/routes/import.ts:121-131` |
| 18 | `/import` (commit) endpoint wraps the identical pipeline + the DB writes in one `prisma.$transaction`, so validation and insert run against the same transactional snapshot and either all land or none do | `MedGuard_Shield_Backend/src/services/importService.ts:374-386` |
| 19 | DB writes: `createMany` per entity on the matching Prisma model (`Asset`, `PHIType`, `Vendor`, `DataFlow`, `AccessGrant`, `Threat`, `Risk`); every row stamped with `organizationId` from `ctx` server-side (CSV cannot specify a tenant) | `MedGuard_Shield_Backend/src/services/importService.ts:300-365` |
| 20 | `risks` import special case: score/band are computed server-side via `computeRisk()` (the same function the live risk engine uses) — a CSV can never submit its own score/band — and a `RiskHistory` row is written per risk with `reason: "IMPORTED"`, `previousScore/previousBand: null` | `MedGuard_Shield_Backend/src/services/importService.ts:327-361`, comment at `importSpec.ts:188-192` |
| 21 | A pre-existing `Risk` row for an asset is rejected as a duplicate — import never updates an existing risk assessment; re-scoring must go through `POST /api/risks/:assetId/recompute` | `MedGuard_Shield_Backend/src/services/importService.ts:229-238` |
| 22 | Audit trail: `IMPORT_STARTED` recorded before work begins, `IMPORT_COMPLETED` or `IMPORT_FAILED` recorded after, each as an `AuditEvent` row with sanitised metadata (no secrets/PHI-flagged keys) | `MedGuard_Shield_Backend/src/routes/import.ts:148-203`, writer at `MedGuard_Shield_Backend/src/services/auditService.ts:1-20,38-48` |
| 23 | Response shapes: validate/import both answer `{data: ImportReport}` on success; a validation failure during commit is a `400` with `{error:{code:"IMPORT_VALIDATION_FAILED", message, report}}`; successful commit is `201 {data: result}` where `result = ImportReport & {imported: number}` | `MedGuard_Shield_Backend/src/routes/import.ts:169-189`, type at `MedGuard_Shield_Backend/src/services/importService.ts:18-23,367` |
| 24 | Frontend surfaces the same `report` shape for both the dry run and the failed-commit 400 body (`error.report`) through `reportFromError`, so one error table renders either case | `Drishti/src/hooks/useImport.ts:52-62` |
| 25 | On a successful commit, frontend invalidates react-query caches for assets/risks/dataFlows/vendors/access/threats (broad invalidation, not entity-scoped) so dependent views (dashboard, risk register, flow map) refresh | `Drishti/src/hooks/useImport.ts:43,129-134` |
| 26 | Template download: `GET /api/import/:entity/template` returns a CSV with header + one example row, gated by the same `import:read` permission as the contract listing | `MedGuard_Shield_Backend/src/routes/import.ts:110-119`, `templateCsv` at `MedGuard_Shield_Backend/src/services/importParsing.ts:69-74` |

## What this does NOT do (verified by reading the code)

- **No OCR.** `grep -rniE "ocr|tesseract"` across both repos' `src` and
  `package.json` returned no matches (binary/generated files excluded).
  Nothing reads pixels; input is CSV text only (`importParsing.ts:1,78-96`).
- **No PDF parsing.** No `pdf-parse`, `pdfjs`, or similar dependency exists in
  either `package.json`; the upload filter rejects anything whose filename
  does not end in `.csv` (`routes/import.ts:35-40`) and the file content is
  read as `utf8` text (`routes/import.ts:79-84`).
- **No AI/LLM document understanding.** `importParsing.ts` and
  `importService.ts` contain no model calls — coercion is deterministic
  regex/type logic (`importParsing.ts:128-205`); there is no AI SDK import in
  either file.
- **No automatic PHI discovery/classification.** PHI *types* (e.g.
  "Clinical", "Financial") are entered by a human on the `phi-types` CSV with
  a human-assigned `sensitivity` enum (`importSpec.ts:86-98`) — nothing scans
  content to infer PHI categories.
- **No live/continuous scanning.** Import is a one-shot, user-initiated
  upload per request; there is no scheduler, webhook, or watcher in
  `routes/import.ts` or `importService.ts` that re-scans files or systems.
- **No EHR/API integration for data entry.** The only way data enters via
  this pipeline is a manually uploaded CSV through this endpoint; `Asset.type`
  includes an `"EHR"` enum value (`importSpec.ts:14`) describing an asset
  *being tracked*, not a live connection to one.
- **No file persistence on disk.** Uploaded bytes live only in memory for the
  duration of the request (`multer.memoryStorage()`, `routes/import.ts:32`)
  and are never written to disk or object storage.
- **No partial commits.** The commit endpoint runs inside one
  `prisma.$transaction` (`importService.ts:379`) — a file either lands
  entirely or not at all; there is no row-by-row partial success on `/import`.

## UNVERIFIED

- **Exact rate-limit interaction with large/slow import traffic** — the
  global limiter (300 req/15min, `middleware/security.ts:34-41`) applies to
  the import routes like any other `/api` route, but no import-specific
  limiter was found. Not re-tested under load. To verify: hit
  `POST /api/import/:entity/validate` >300 times in 15 minutes against a
  non-test env and confirm the global limiter's 429 response.
- **Actual multer error-code coverage beyond `LIMIT_FILE_SIZE`** — only that
  code is special-cased (`routes/import.ts:56-59`); other `MulterError` codes
  fall through to a generic `BadRequestError` (`:60-61`). Not enumerated
  against multer's full error-code list or exercised in tests beyond what
  `tests/integration/import.test.ts` covers. To verify: read
  `MedGuard_Shield_Backend/tests/integration/import.test.ts` and/or trigger
  `LIMIT_UNEXPECTED_FILE` by sending a second form field.
- **Whether `ANALYST`/`VIEWER` roles can be granted `import:execute` via any
  other code path** (e.g. a future permissions override) — confirmed only
  that the current static grant set excludes them
  (`lib/permissions.ts:98,104-106`). To verify: grep for any other call site
  that constructs permissions dynamically.
