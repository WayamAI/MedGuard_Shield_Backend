# MedGuard — CSV Import Guide

How to load real data into MedGuard from a spreadsheet, without a developer
editing `prisma/seed.ts`.

There are seven importable entities, one file per entity. There is no combined
file: a single sheet holding assets and the flows between them cannot express
"this flow needs both of its assets to exist first", and that ordering is the
whole difficulty.

---

## The three endpoints

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/import` | The column contract for all seven entities, as JSON. |
| `GET` | `/api/import/:entity/template` | Downloads a CSV with the header row and one filled-in example row. |
| `POST` | `/api/import/:entity/validate` | Dry run. Parses and checks everything, writes nothing. |
| `POST` | `/api/import/:entity` | Imports for real, in a single transaction. |

`:entity` is one of:

```
assets   phi-types   data-flows   vendors   access-grants   threats   risks
```

**All four require the `ADMIN` role.** `ANALYST` and `VIEWER` get `403`; an
unauthenticated caller gets `401`. This is deliberately narrower than the
`ADMIN`/`ANALYST` gate on ordinary writes — import writes straight into the PHI
inventory.

Both `POST` endpoints take a **multipart** upload with the file in a field
named `file`.

### The normal working order

1. `GET .../template` — download the file with the right columns.
2. Fill it in, one row per record.
3. `POST .../validate` — fix whatever it reports. Nothing is written.
4. `POST /api/import/:entity` — commit.

Step 3 is not optional in practice. Import is all-or-nothing, so a 400-row file
with one bad cell imports nothing at all; validating first turns that into a
list you can fix in one pass.

### What the report looks like

Both `POST` endpoints return the same shape:

```json
{
  "valid": false,
  "totalRows": 3,
  "errors": [
    { "row": 3, "field": "type", "message": "type must be one of: EHR, DATABASE, API, CLOUD_STORAGE, ANALYTICS, OTHER. Got \"MAINFRAME\"" },
    { "row": 4, "field": "name", "message": "Asset \"Radiology PACS\" already exists, matched on name. Import only adds new records." }
  ],
  "preview": [ { "name": "Radiology PACS", "type": "CLOUD_STORAGE" } ]
}
```

- **`row`** is the line number in the file, counting the header as row 1. So the
  first record is row 2 — the same number the spreadsheet shows down its left
  edge.
- **`preview`** is the first 10 rows as parsed, shown with the names you typed
  rather than database ids, so you can check the file was read the way you meant.
- `/validate` returns **200** even when `valid` is `false` — a dry run that found
  problems is a dry run that worked.
- `/import` returns **201** on success with `imported: <count>`, or **400** with
  `error.code = "IMPORT_VALIDATION_FAILED"` and the identical report under
  `error.report`.

---

## Foreign keys are written as names, not ids

Nobody filling in a spreadsheet knows that Epic EHR Core is row 3. So every
reference is written as the record's name, and the server resolves it:

| Column | Resolves against | Must already exist |
|---|---|---|
| `sourceAssetName`, `targetAssetName`, `assetName` | `Asset.name` | yes |
| `phiTypeName` | `PHIType.name` | yes |
| `identityName` | `Identity.displayName` | yes |

Matching is **case-insensitive**: `epic ehr core` finds `Epic EHR Core`.

If a name does not resolve, that row fails with
`No Asset found named "X". Create it first, then re-import.` Nothing is
imported. This is why the import order matters:

```
1. assets, phi-types        (no references — import these first)
2. vendors                  (no references)
3. data-flows, risks, threats, access-grants   (all reference assets)
```

`Identity.displayName` carries no unique constraint. If two identities share a
display name, the row fails as ambiguous rather than the server guessing.
**Identities are not importable** — they are created through the seed or
directly — so access grants can only be imported for identities that exist.

---

## Duplicate detection

Every entity has a **natural key**. A row is refused if that key is already used
by another row **in the same file**, or by a record **already in the database**.
Import only ever adds; it never updates.

| Entity | Natural key | Mirrors |
|---|---|---|
| `assets` | `name` | `Asset.name @unique` |
| `phi-types` | `name` | `PHIType.name @unique` |
| `vendors` | `name` | `Vendor.name @unique` |
| `data-flows` | `sourceAssetName` + `targetAssetName` + `phiTypeName` | no DB constraint; chosen so the same PHI type cannot be routed twice between the same pair |
| `access-grants` | `identityName` + `assetName` | `@@unique([identityId, assetId])` |
| `threats` | `assetName` + `title` | no DB constraint; two different findings on one asset are fine, the same title twice is not |
| `risks` | `assetName` | no DB constraint — see below |

**Why `risks` is keyed on the asset alone.** The schema permits many `Risk` rows
per asset, as history. Import refuses a second one anyway: a spreadsheet that
quietly adds a competing assessment beside the existing one is far more likely
to be a mistake than an intent. To rescore an asset that already has a risk, use
`POST /api/risks/:assetId/recompute`.

---

## Column specs

Types: `string`, `int`, `boolean` (`true/false`, `yes/no`, `y/n`, `1/0`, any
case), `date` (**`YYYY-MM-DD` only**), `enum` (any case, stored uppercase).

Leaving an optional column blank applies the database default — it does not
write null over it.

### `assets`

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **yes** | Unique. Max 120 chars. |
| `type` | enum | **yes** | `EHR`, `DATABASE`, `API`, `CLOUD_STORAGE`, `ANALYTICS`, `OTHER` |
| `phiVolume` | int | no | ≥ 0. Defaults to 0. |
| `encrypted` | boolean | no | Defaults to false. |
| `mfaEnabled` | boolean | no | Defaults to false. |
| `lastAssessedAt` | date | no | Blank means never assessed. |

### `phi-types`

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **yes** | Unique. |
| `sensitivity` | enum | **yes** | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |

### `data-flows`

| Column | Type | Required | Notes |
|---|---|---|---|
| `sourceAssetName` | ref → Asset | **yes** | Must exist. |
| `targetAssetName` | ref → Asset | **yes** | Must exist. |
| `phiTypeName` | ref → PHIType | **yes** | Must exist. |
| `recordsPerDay` | int | **yes** | ≥ 0. No default in the schema, so it is required. |
| `encrypted` | boolean | no | Defaults to **true**. |

### `vendors`

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **yes** | Unique. |
| `baaStatus` | enum | no | `SIGNED`, `PENDING`, `EXPIRED`, `MISSING`. Defaults to `MISSING`. |
| `phiVolume` | int | no | ≥ 0. Defaults to 0. |
| `lastAssessedAt` | date | no | |

### `access-grants`

| Column | Type | Required | Notes |
|---|---|---|---|
| `identityName` | ref → Identity | **yes** | `Identity.displayName`. Must exist and be unambiguous. |
| `assetName` | ref → Asset | **yes** | Must exist. |
| `level` | enum | no | `READ`, `WRITE`, `ADMIN`. Defaults to `READ`. |
| `grantedAt` | date | no | Defaults to today. |
| `lastUsedAt` | date | no | Blank means never used — which is what the access review flags. |

### `threats`

| Column | Type | Required | Notes |
|---|---|---|---|
| `assetName` | ref → Asset | **yes** | Must exist. |
| `severity` | enum | **yes** | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `status` | enum | no | `OPEN`, `INVESTIGATING`, `RESOLVED`, `FALSE_POSITIVE`. Defaults to `OPEN`. |
| `title` | string | **yes** | Max 200 chars. Part of the natural key. |
| `description` | string | **yes** | Max 2000 chars. |
| `detectedAt` | date | no | Defaults to today. |
| `resolvedAt` | date | no | Blank while still open. |

### `risks`

| Column | Type | Required | Notes |
|---|---|---|---|
| `assetName` | ref → Asset | **yes** | Must exist. |
| `likelihood` | int | **yes** | 1–5 |
| `impact` | int | **yes** | 1–5 |
| `exposure` | int | **yes** | 1–5 |
| `controlGap` | int | **yes** | 1–5 |

**There is no `score` or `band` column, and there will not be one.** Both are
derived from the four judgements by the same scoring engine the API uses
(`src/services/riskScoring.ts`). A spreadsheet cannot overrule the engine
because it is never asked.

---

## Worked example — a 2-row assets file

**Before.** The estate has 8 assets; `Radiology PACS` is not among them.

Download the template:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/import/assets/template -o assets.csv
```

```csv
name,type,phiVolume,encrypted,mfaEnabled,lastAssessedAt
Epic EHR Core,EHR,412000,true,true,2026-08-14
```

Replace the example row with your own two:

```csv
name,type,phiVolume,encrypted,mfaEnabled,lastAssessedAt
Radiology PACS,CLOUD_STORAGE,96500,true,false,2026-07-22
Telehealth Gateway,API,18400,true,true,
```

Dry run:

```bash
curl -X POST http://localhost:4000/api/import/assets/validate \
  -H "Authorization: Bearer $TOKEN" -F "file=@assets.csv;type=text/csv"
```

```json
{ "data": { "valid": true, "totalRows": 2, "errors": [], "preview": [ ... ] } }
```

Import:

```bash
curl -X POST http://localhost:4000/api/import/assets \
  -H "Authorization: Bearer $TOKEN" -F "file=@assets.csv;type=text/csv"
```

```
HTTP 201
{ "data": { "valid": true, "totalRows": 2, "errors": [], "imported": 2 } }
```

**After.** `GET /api/assets` returns 10 rows. The two new ones:

| id | name | type | phiVolume | encrypted | mfaEnabled | lastAssessedAt |
|---|---|---|---|---|---|---|
| 9 | Radiology PACS | CLOUD_STORAGE | 96500 | true | false | 2026-07-22 |
| 10 | Telehealth Gateway | API | 18400 | true | true | *(null)* |

Note `Telehealth Gateway`: the blank `lastAssessedAt` became null, and the
blank-free columns took the values given. The `encrypted` default was not
needed because the column was filled in.

---

## File handling and safety

- **`.csv` only**, by filename. Anything else is refused with 400.
- **2MB maximum.** Larger uploads are refused with `413 FILE_TOO_LARGE` before
  the file is parsed. That is roughly 20,000 rows — well past a realistic
  estate.
- Files are held **in memory** and never written to disk.
- **No cell is ever executed or evaluated.** Every value is coerced to a string,
  number, boolean or date and handed to Prisma as a bound parameter. A name
  containing SQL is stored as text, exactly as typed.
- **Formula-injection guard.** A text cell starting with `=`, `+`, `-`, `@`, a
  tab or a carriage return is **rejected**, because MedGuard renders these
  strings back into a UI and will export them to CSV again, and a value that
  becomes live code in a client's spreadsheet is not data. CSVs that MedGuard
  *generates* additionally prefix such values with `'` so Excel treats them as
  text.

  The cost of this is real: an asset legitimately named `-Legacy Billing` is
  refused. Rename it, or drop the leading character. Numeric columns are
  unaffected — a negative number is parsed as a number, not as a formula.

- **Line endings.** CRLF, LF and CR are all accepted, including a file that
  mixes them — which is what you get by downloading a template and appending
  rows in a text editor.
- A UTF-8 **BOM** is stripped, since Excel writes one by default.

---

## Atomicity

`POST /api/import/:entity` runs the whole file inside **one transaction**. If any
row fails any check, the request is rejected and **nothing is written** —
including the rows that were perfectly fine. There is no partial import and no
"imported 340 of 400" state to reconcile.

The validation is re-run inside that transaction rather than trusting the
result of an earlier pass, so a record created between your `/validate` call and
your `/import` call is still caught.
