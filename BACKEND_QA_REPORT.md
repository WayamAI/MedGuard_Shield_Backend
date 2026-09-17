# MedGuard Backend — Pre-Demo QA Report

Full QA pass over the API, run on `main` at `46e149c` after
`feature/data-import-backend` was fast-forward merged.

**Result: pass.** 22 endpoints, all with happy-path and failure-path coverage.
246 tests green, `tsc --noEmit` clean, lint clean, demo data verified at 8
assets / 402,200 records per day.

| | |
|---|---|
| Branch | `main` @ `46e149c` |
| Tests | 246 passed / 246 (11 files) |
| Typecheck | clean (`tsconfig.json` + `tsconfig.test.json`) |
| Lint | clean, 0 warnings |
| Manual smoke | 14 happy + 23 failure paths, all correct |
| Demo data | 8 assets, 402,200 records/day, 5 risk bands, 3 flow tones |

---

## Endpoint inventory and coverage

`app.use("/api", requireAuth)` (`src/app.ts:50`) gates everything mounted below
it. "Any role" means any authenticated user — `ADMIN`, `ANALYST` or `VIEWER`.

| # | Method | Path | Auth / RBAC | Happy | Failure | Covered by |
|---|---|---|---|---|---|---|
| 1 | GET | `/health` | public | ✅ | ✅ 404 wrong method | `auth`, `routes` |
| 2 | POST | `/api/auth/login` | public + login limiter | ✅ | ✅ 401, 400, 429 | `auth`, `security` |
| 3 | POST | `/api/auth/logout` | public | ✅ | ✅ see note | `auth` |
| 4 | GET | `/api/auth/me` | requireAuth | ✅ | ✅ 401 | `auth`, `routes` |
| 5 | GET | `/api/assets` | any role | ✅ | ✅ 401 | `routes` |
| 6 | GET | `/api/assets/:id` | any role | ✅ | ✅ 404, 400 ×2 | `routes` |
| 7 | POST | `/api/assets` | **ADMIN, ANALYST** | ✅ | ✅ 403, 401, 400 ×3, 409 | `rbac` |
| 8 | PATCH | `/api/assets/:id` | **ADMIN, ANALYST** | ✅ | ✅ 403, 404, 400 | `rbac` |
| 9 | GET | `/api/dataflows` | any role | ✅ | ✅ 401 | `routes` |
| 10 | GET | `/api/risks` | any role | ✅ | ✅ 401 | `routes` |
| 11 | POST | `/api/risks/:assetId/recompute` | **ADMIN, ANALYST** | ✅ | ✅ 403, 401, 404, 400 | `rbac`, `routes` |
| 12 | GET | `/api/vendors` | any role | ✅ | ✅ 401 | `vendors` |
| 13 | GET | `/api/vendors/:id` | any role | ✅ | ✅ 404, 400 | `vendors` |
| 14 | POST | `/api/vendors` | **ADMIN, ANALYST** | ✅ | ✅ 403, 409, 400 | `vendors` |
| 15 | PATCH | `/api/vendors/:id` | **ADMIN, ANALYST** | ✅ | ✅ 403, 404, 400 | `vendors` |
| 16 | POST | `/api/vendors/:id/recompute` | **ADMIN, ANALYST** | ✅ | ✅ 403, 404, 400 | `vendors` |
| 17 | GET | `/api/access` | any role | ✅ | ✅ 401 | `access` |
| 18 | GET | `/api/threats` | any role | ✅ | ✅ 401 | `threats` |
| 19 | GET | `/api/import` | **ADMIN** | ✅ | ✅ 403 ×2, 401 | `import` |
| 20 | GET | `/api/import/:entity/template` | **ADMIN** | ✅ ×7 | ✅ 403 ×2, 401, 404 | `import` |
| 21 | POST | `/api/import/:entity/validate` | **ADMIN** | ✅ | ✅ 403 ×2, 401, 400 | `import` |
| 22 | POST | `/api/import/:entity` | **ADMIN** | ✅ ×7 | ✅ 403, 401, 400, 404, 413 | `import` |

Test files: `tests/integration/{auth,routes,rbac,vendors,access,threats,security,import}.test.ts`,
plus unit tests in `src/services/{riskScoring,flowStatus,importParsing}.test.ts`.

**Note on `/api/auth/logout`.** It has no genuine failure path: it is public,
and clearing a cookie that is not there is not an error. Two tests pin that
down as intended behaviour rather than leaving it looking like a routing
accident.

### Gaps found and closed during this pass

Each of the 22 endpoints was checked individually against the suite rather than
assumed covered. Five were missing a direction, and all five were fixed in
`46e149c` (+13 tests, 233 → 246):

| Endpoint | What was missing |
|---|---|
| `GET /api/import` | **No test at all.** Shipped with the import feature; nothing exercised it. |
| `GET /health` | No failure path — any non-GET method should be a structured 404. |
| `POST /api/auth/logout` | Happy path only. |
| `POST /api/vendors/:id/recompute` | No 404 / 400 case. |
| `PATCH /api/vendors/:id` | No 404 / empty-body case. |

---

## Manual smoke test

Every endpoint was curled once on the happy path and once on a failure path
against a running server.

**Happy paths — 14/14 correct**, all `200` (or `201` for import), all returning
the `{ data: ... }` envelope.

**Failure paths — 23/23 correct:**

```
401 UNAUTHORIZED     × 7      403 FORBIDDEN         × 4
404 NOT_FOUND        × 5      404 ROUTE_NOT_FOUND   × 2
400 VALIDATION_ERROR × 2      400 BAD_REQUEST       × 1
```

No response leaked a stack trace, an HTML error page, or an internal path.

### Security posture — re-confirmed after the merge

| Control | Status |
|---|---|
| CORS | Pinned to `http://localhost:8080`, `credentials: true`. An `evil.example` origin is **not** echoed back. |
| Security headers | HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer` |
| `x-powered-by` | Removed |
| CSP | Deliberately off — this process serves JSON only |
| Global rate limit | `RateLimit-Policy: 300;w=900` |
| Login rate limit | 10 per 15 min, failures only (`skipSuccessfulRequests`) |
| Error bodies | Structured JSON; no stack traces; request payloads never echoed or logged |

---

## Demo data verification

One reseed was run after the frontend session confirmed its import testing was
finished, then:

```
assets                  8        PASS
SUM(recordsPerDay) 402,200       PASS
distinct risk bands     5        PASS   LOW 2, MODERATE 3, HIGH 1, CRITICAL 1, EXTREME 1
dataflow status tones   3        PASS   ok 3, warn 5, violation 2
assets beyond seeded 8  0        PASS
```

Both count *and* sum are asserted deliberately. During this build two assets
were added while `SUM(recordsPerDay)` stayed at 402,200 — checking only the
records figure would have reported a clean state that was not clean.

---

## Known limitations

### Behaviour that is correct but will surprise someone

**An imported asset has no risk score until a Risk row exists for it.**
Verified end to end during this pass: importing an asset returns
`risk: null` from `GET /api/assets` and the asset does not appear in
`GET /api/risks`; importing a Risk CSV row for that same asset immediately
populates both. This is not a scoring bug. `createAsset` and the Assets import
path both create *only* `Asset` rows, so an imported asset behaves exactly like
one added by hand with no assessment done. A risk score exists only because a
`Risk` row was created — by seed, by Risk CSV import, or by an assessor.
Worth reflecting in the demo script if an asset is imported live.

**Risks import refuses a second risk for an asset that already has one.**
The schema permits a history of `Risk` rows; import does not, because a
spreadsheet quietly adding a competing assessment is more likely a mistake than
an intent. Rescoring goes through `POST /api/risks/:assetId/recompute`.

**The formula guard rejects a legitimate leading `-`.** A text cell starting
with `=`, `+`, `-`, `@`, tab or CR is refused, so an asset named
`-Legacy Billing` cannot be imported. Deliberate: these strings are rendered
back into a UI and exported to CSV again. Numeric columns are unaffected.

**Identities and AssetPHI links are not importable.** Access grants can only be
imported for identities that already exist. There is no CSV path for either.

### New, found during this pass

**`medguard_dev` is shared with no isolation between sessions.** Backend QA and
frontend UI testing write to the same database, so test rows interleave with
demo data. This actually happened: two assets appeared mid-pass from the
frontend session. Pointing UI testing at a separate database would prevent it.
Mitigation today is the reseed, which is why it is run once, immediately before
the rehearsal.

**CI does not run on feature branches.** `575488f` narrowed the workflow
triggers to `main`, so everything on `feature/data-import-backend` was verified
locally only. See backlog item 15.

### Carried from `POST_DEMO_BACKLOG.md`

Still open, unchanged by this pass — see that file for the full reasoning:

| # | Item |
|---|---|
| 4 | `SameSite=Lax` cookie breaks once API and frontend are on different domains |
| 5 | `prisma migrate reset --force` documented but never executed |
| 6 | No pagination on any list endpoint |
| 7 | RBAC is coarse — no ownership, no department scoping |
| 8 | No delete endpoints anywhere |
| 9 | `AccessGrant.lastUsedAt` is seeded, never written by the app |
| 10 | Threats are read-only — no status transition endpoint |
| 11 | Risk inputs cannot be edited through the API |
| 12 | CI never tests a migration against a populated database |
| 15 | `post-demo/expansion` is merged but has no CI coverage |

Closed: items 1, 2, 3, 13, 14.

---

## Verdict

The backend is ready to sit in front of a client. Every endpoint is covered in
both directions, the security posture survived the import feature landing, and
the demo dataset is verified at its known-good numbers.

The one thing to decide before the rehearsal is presentational, not technical:
if an asset is imported live, it will not appear in the Risk Register until a
risk assessment exists for it. That is the product behaving correctly — but it
is worth saying out loud rather than discovering on the call.
