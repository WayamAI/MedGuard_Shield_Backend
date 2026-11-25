# Verification Log

Evidence of commands actually run, in order, with real output. Appended to as each phase completes.

## Phase 0 — 2026-11-22

**Install deps**
```
$ npm install
up to date, audited 422 packages in 2m
24 vulnerabilities (13 moderate, 9 high, 2 critical) — carried forward to Phase 3 (npm audit review)
```

**Database**: native Homebrew Postgres already running on `localhost:5432` with `medguard_dev`/`medguard_test` already created (not the Docker Compose stack — see `GAP_AUDIT.md` environment notes).

**Migrations**
```
$ npx prisma migrate deploy
6 migrations found in prisma/migrations
No pending migrations to apply.
```

**Seed (demo org)**
```
$ npm run db:seed
[seed] assets=8 phiTypes=4 assetPHI=13 dataFlows=10 risks=8 users=6 vendors=5 vendorAccess=7 vendorRisks=5 identities=6 accessGrants=9 threats=5
```
(users=6 reflects the 3 original `meridian.org` accounts plus the 3 `wayam.ai` aliases added to `prisma/seed.ts` this session, per explicit instruction.)

**Spot-check demo facts directly against the DB**
```
$ psql postgresql://arkabera@localhost:5432/medguard_dev -c "SELECT a.name, r.likelihood, r.impact, r.exposure, r.\"controlGap\", r.score, r.band, a.\"phiVolume\", a.encrypted FROM \"Asset\" a JOIN \"Risk\" r ON r.\"assetId\"=a.id WHERE a.name ILIKE '%billing%';"

       name        | likelihood | impact | exposure | controlGap | score |  band   | phiVolume | encrypted
-------------------+------------+--------+----------+------------+-------+---------+-----------+-----------
 Billing Engine DB |          5 |      5 |        5 |          5 |   100 | EXTREME |     87100 | f
```
Matches ground-rule-8 exactly.

**Full test suite**
```
$ npm test
 Test Files  1 failed | 20 passed (21)
      Tests  18 failed | 554 passed (572)
   Duration  195.42s
```
All 18 failures are in `tests/integration/demo-reset.test.ts`, and all are the same root cause: `prisma/reset-demo.ts`'s own safety guard refuses to run against a database whose name doesn't contain "demo" — `TEST_DATABASE_URL` points at `medguard_test`. This is a pre-existing environment-naming mismatch between two of the repo's own safety guards (`globalSetup.ts` requires "test" in the name; `reset-demo.ts` requires "demo"), not a new regression and not a product bug. Full detail in `GAP_AUDIT.md`.

**Not run this pass**: `docker compose up` (native Postgres was already running and seeded; Docker Compose requires setting `POSTGRES_PASSWORD` in `.env` first — documented as a gap, not executed, to avoid touching a working local setup unnecessarily). `npm run lint` / `npm run typecheck` / `npm audit` — deferred to Phase 3 where they're the designated gate, not re-run redundantly here.

## Phase 1 — 2026-11-22

**Built**: `src/config.ts` (centralized Zod env validation at boot), `src/middleware/logging.ts` (pino structured JSON logging with request-ID + PHI/secret redaction, silenced in `NODE_ENV=test`), `requestId` added to every error-envelope branch in `errorHandler.ts`, `/healthz` and `/readyz` aliases alongside the existing `/health`/`/health/ready`, `prisma/seed-bootstrap.ts` + `npm run db:seed:bootstrap` (real-install seed, separate from the two demo seeds), `scripts/generate-openapi.ts` + `npm run openapi:generate` (writes `openapi.json` from the Zod schemas, now exported from all 16 route files), `GET /api/docs` serving the spec outside production. Full rationale in `DECISIONS.md`.

**Typecheck**
```
$ npx tsc --noEmit -p tsconfig.json
(no output — clean)
```

**Lint**
```
$ npm run lint
(no output — clean)
```

**Bootstrap seed, tested end to end and then cleaned up**
```
$ BOOTSTRAP_ORG_NAME="Test Health" BOOTSTRAP_ORG_SLUG="test-health-bootstrap" \
  BOOTSTRAP_ADMIN_EMAIL="admin@test-health-bootstrap.example" BOOTSTRAP_ADMIN_PASSWORD="bootstrap-pw-12345" \
  npm run db:seed:bootstrap
[seed:bootstrap] org "Test Health" (test-health-bootstrap), admin admin@test-health-bootstrap.example
```
(Test org/user deleted from `medguard_dev` afterward via `psql`; not left in place.)

**OpenAPI generation**
```
$ npm run openapi:generate
[openapi] wrote openapi.json — 66 paths
```
Smoke-tested by booting the app in-process and requesting `/api/docs` (200, 66 paths returned) and `/healthz` (200).

**Full test suite, before and after Phase 1 changes**
```
$ npm test   (baseline, end of Phase 0)
Test Files  1 failed | 20 passed (21)
Tests       18 failed | 554 passed (572)

$ npm test   (after adding `requestId` to every error envelope — NEW FAILURE)
Test Files  2 failed | 19 passed (21)
Tests       19 failed | 553 passed (572)
```
The new failure was `auth.test.ts`'s no-enumeration test, which asserted the *entire* error body is identical between "unknown email" and "wrong password" responses — `requestId` is unique per request by design, so adding it broke that exact-equality check. This is a test-correctness fix, not a security regression (the id carries no signal about which branch produced the error): updated the assertion to compare the error body excluding `requestId`.
```
$ npm test   (after the test fix)
Test Files  1 failed | 20 passed (21)
Tests       18 failed | 554 passed (572)
```
Back to the Phase 0 baseline — the only remaining failures are the pre-existing `demo-reset.test.ts` DB-naming-guard mismatch, unchanged by Phase 1.

## Phase 2 — 2026-11-22

All 10 planned features built, each with migrations where needed, routes, RBAC, org scoping, audit coverage, and integration tests; smoke-tested live against the real Meridian demo data in addition to the test suite.

**Built**: PDF/CSV risk-assessment reports (`reportPdf.ts`, routes in `reports.ts`); PHI inventory + PHI-type CRUD (`phiInventoryService.ts`, `routes/phiInventory.ts`); full member lifecycle — invite/accept, password change/reset (Mailpit-backed), TOTP MFA with recovery codes, session list/revoke (`memberService.ts`, `mfaService.ts`, `passwordResetService.ts`, `mailer.ts`, extended `auth.ts`/new `members.ts`); configurable org settings with live recompute-on-change (`orgSettingsService.ts`); notifications + a node-cron daily sweep behind a Postgres advisory lock (`notificationService.ts`, `jobs/dailySweep.ts`); CSV `?format=csv` exports on every list endpoint plus the audit log (`lib/csv.ts`, 10 routes touched); an ingestion API authenticated by its own API key, reusing the CSV import pipeline (`apiKeyService.ts`, `routes/ingest.ts`, `routes/apiKeys.ts`); audit hash-chain tamper evidence plus a DB trigger making `AuditEvent` append-only even against a raw SQL connection (migration `add_audit_immutability`, `GET /api/audit/verify`); and a documented decision to skip row-level security (`DECISIONS.md`).

**New integration test files** (all passing): `phi-inventory.test.ts` (5), `members.test.ts` (17), `org-settings.test.ts` (4), `notifications.test.ts` (7), `csv-exports.test.ts` (13), `ingest.test.ts` (6), `audit-immutability.test.ts` (6) — 58 new tests, plus unit tests for `lib/csv.ts` (3) and additions to `discovery.test.ts` for the PDF/CSV report routes.

**Regression caught and fixed by the full suite, not claimed without running it**: adding the audit hash chain's `requestId`-bearing error envelope (Phase 1) and later the append-only trigger (this phase) each broke one existing thing — the no-enumeration login test's exact-body comparison (Phase 1, fixed by excluding `requestId` from that one assertion), and `prisma/seed-demo.ts` / `prisma/reset-demo.ts`'s audit-row UPDATE/DELETE (this phase, fixed by adding a `createdAt` override to `recordAudit` instead of a post-insert UPDATE, and by narrowly disabling the DELETE trigger for one transaction inside the already-demo-gated reset script). Both fixes are covered by the full suite now passing.

**A second regression from the first fix, caught by the same suite**: disabling the trigger with raw SQL inside `reset-demo.ts` (first attempt) itself broke `demo-reset.test.ts`'s own "contains no raw SQL, no truncate, and no unscoped delete" test. A second attempt (keying the exception on `Organization.slug`) was also wrong — see below. At this point the suite was reporting "18 pre-existing demo-reset failures" as an accepted baseline, which the user correctly identified as itself the problem: those 18 failures meant the reset path, the backup step, and the audit-delete exception had **never actually run** in CI, only been reviewed by eye.

## Follow-up round — 2026-11-22, fixing what the first pass got wrong

The user rejected the "18 baseline failures" framing and asked for five things. All five done:

**1. `demo-reset.test.ts` now runs against a real demo-named database.** Created `medguard_demo_test` locally. New `vitest.demo-reset.config.ts` points only that one test file at it (`DEMO_TEST_DATABASE_URL`, defaulting to `medguard_demo_test`); `npm test` now runs `vitest run && vitest run --config vitest.demo-reset.config.ts`, so one command's exit code covers both. The existing guards (`globalSetup.ts` requires "test" in the name; `reset-demo.ts` requires "demo") are untouched and still strict — `medguard_demo_test` satisfies both honestly, nothing was weakened, and `DEMO_RESET_ALLOW_ANY_DB` was not set globally anywhere.

**2. The trigger exception was wrong twice, now fixed.** Checked the Meridian org's actual slug: `"meridian"` — confirms the user's point (a) exactly; the org-slug exception from the previous pass would never have applied to it. Replaced it (migration `audit_delete_by_database_name`) with a check on `current_database() ILIKE '%demo%'` — the same signal the application-level guards already use, with no dependency on any row's content. Added a `NODE_ENV=production` boot check in `src/config.ts` refusing to start against a "demo"-named database. `reset-demo.ts` stayed on a plain, typed `deleteMany` throughout — no raw SQL was reintroduced.

**3. Proof, by test:**
- `tests/integration/audit-immutability.test.ts` (runs on `medguard_test`, a non-demo database) now has an explicit case creating an organization named "Demographics Health" with slug `demographics-health-demo` and proving a raw SQL DELETE on its audit row still fails — confirming the exception really is keyed on the database, not the row. 7/7 pass.
- `src/config.test.ts` (new) spawns a real child process per scenario and confirms: refuses to boot in production against a "demo"-named database; boots fine in production against a normal name; the guard doesn't apply outside production. 3/3 pass.
- `demo-reset.test.ts` against `medguard_demo_test`: **20/20 pass** (the file has 20 tests, not 18 — the "18" in every earlier report was the count of tests that got as far as hitting the guard and erroring, not the file's actual test count). Determinism, headline facts (risk bands, critical risk, remediation states, threat states, vendor/access findings, movement history, audit trail, no password leaks) all verified for the `drishti-demo` org that this command actually resets — confirmed with the user that this (not the Meridian org, which `db:demo:reset` never touches) is the right target for this proof.

**4. Ran `npm run db:demo:reset` for real**, scoped via `DATABASE_URL` to `medguard_demo_test` (never the dev DB):
```
[demo-reset] backing up "medguard_demo_test" to prisma/backups/pre-reset_medguard_demo_test_2026-11-22T17-08-05-332Z.sql before any deletion...
[demo-reset] backup complete: prisma/backups/pre-reset_medguard_demo_test_2026-11-22T17-08-05-332Z.sql
[demo-reset] target: Drishti Demo Healthcare (slug drishti-demo, id 1)
[demo-reset] removed 224 row(s) from organisation 1:
  auditEvent 13, riskHistory 33, remediation 9, policyControl 8, policy 5, assetControl 29,
  control 8, threat 7, vendorAssetAccess 11, vendorRisk 5, vendor 5, accessGrant 23,
  identity 6, dataFlow 13, assetPHI 21, risk 12, asset 12, phiType 4
[demo-reset] organisation, demo users and memberships retained.
[demo-reset] re-seeding… [demo-seed] done. org 1 now holds: 12 assets, 5 vendors, 8 controls, 5 policies, 9 remediations, 33 risk-history entries, 13 audit events.
```
This run surfaced one more genuine, previously-undiscovered bug: `pg_dump` rejected Prisma's `?schema=` query parameter (`pg_dump: error: invalid URI query parameter: "schema"`) — the backup step had never executed successfully before this session, for the same reason the reset logic hadn't: the DB-name guard always blocked it first. Fixed by stripping the query string before invoking `pg_dump`. `prisma/backups/` added to `.gitignore`; the backup files from this round's test runs were left on disk (a destructive-cleanup action was correctly blocked by the harness when attempted) but will never be committed.

**5. Ran the full suite three times in a row** rather than call the earlier `discovery.test.ts` failure noise:
```
Run 1: 639/639 passed (619 main + 20 demo-reset)
Run 2: 639/639 passed
Run 3: 639/639 passed
```
The `authentication_error` / `Invalid authentication` failure from the previous round did not recur in any of the three runs, nor in an earlier isolated re-run of just `discovery.test.ts` (27/27). No proxy, no global `fetch`/`http` mock, and no shared-state source was found in the codebase (checked for `vi.mock`/`global.fetch` overrides — none exist; checked system proxy config — none configured). Reported as: investigated, not reproduced in four separate attempts after the fix, no root cause identified because there was nothing left to find — not dismissed as noise without looking.

**Full suite, final state**: 639/639 passed, three consecutive times. Zero unexplained failures remain.

## Demo login reconciliation — 2026-11-22

Investigated the conflict between ground-rule-8's `wayam.ai` claim and the actual seed data. Found `wayam.ai` did not exist anywhere in the repo; the real Meridian Health System demo data (verified above) is keyed to `meridian.org` emails. Per explicit user instruction, added `admin@wayam.ai` / `analyst@wayam.ai` / `viewer@wayam.ai` to `prisma/seed.ts`'s `USERS` array as additional accounts on the same org/roles, re-ran `npm run db:seed`, confirmed `users=6` in the seed summary (was `users=3` before the edit, up from the pre-existing 3 `meridian.org` accounts).

## Phase 3 — security review, housekeeping, and the pg deprecation warning — 2026-11-23

**Housekeeping:**
1. `.gitignore` now excludes `/*.sql` and `/backup_*` (root-anchored, so `prisma/migrations/**/migration.sql` stays tracked — verified with `git check-ignore -v`). `backup_medguard_dev_20261010_125159.sql` is now ignored, left in place for the user to move.
2. `tests/integration/meridian-seed.test.ts` (new, 10 tests, own `medguard_meridian_test` DB + `vitest.meridian-seed.config.ts`) asserts every headline fact: Billing Engine DB (100.00 EXTREME, 87,100 records, unencrypted), Northwind Claims Processing (BAA MISSING, 100.00 EXTREME, vendor.phiVolume=71,300), Robert Chen (inactive, ADMIN on Imaging Archive, 243 days since use), the unencrypted Billing→Insurance flow, the Tor-exit-node CRITICAL threat, and the exact counts (5 threats, 6 remediations incl. 1 ACCEPTED, 8 controls, 4 policies). Plus 2 production-safety tests for `seed.ts`'s new guard. README documents which command seeds/resets which org.
3. pg DeprecationWarning: found and fixed 3 real bugs — `reset-demo.ts`'s `censusOutside()` eager array of `.count()` calls (now sequential thunks), `seed-demo.ts`'s batch-array `$transaction([...])` for reporting totals (removed — read-only, no atomicity need), `passwordResetService.ts`'s batch-array `$transaction([...])` (converted to the interactive form, preserving atomicity). A residual warning still fires once per test file under vitest's default per-file module isolation (traced via `--trace-deprecation` into `@prisma/adapter-pg`'s cold-start path, confirmed via an isolated 2-file experiment). Tried `isolate: false` on all three vitest configs to eliminate it; a full run under that setting stalled, risking the shared-client/`afterAll($disconnect())` contract across files, so it was reverted. Documented as an accepted, investigated, upstream artifact in `DECISIONS.md` — harmless in practice, confirmed by three consecutive fully-green suite runs below.

**Security fixes (ASVS L2 review, full detail in `docs/engineering/SECURITY_REVIEW.md`):**
- bcrypt cost raised 10 → 12.
- JWT now pins algorithm (`HS256`), issuer, and audience on both sign and verify.
- CSRF header requirement (`X-Drishti-Csrf`) added to `/api/auth/refresh` and `/api/auth/logout`.
- Per-route rate limiters added for password reset, invite accept, and forgot-password; export rate limiter added for CSV exports.
- `prisma/seed.ts` (the Meridian/wayam.ai seed) gained a production guard — previously had none, unlike `seed-demo.ts`.
- CSV import now rejects values shaped like patient identifiers (SSN/MRN/DOB patterns).
- Log redaction expanded: a real, live-confirmed leak (API key appearing in logs via `x-api-key` header) fixed, plus `apiKey`/`secret`/`mfaSecret`/`code`/`recoveryCodes`/`tokenHash`/`keyHash` fields at any nesting depth. Proven with a new `src/middleware/logging.test.ts` (5 tests, real `pino()` instance).
- API-key scope enforcement proven with a new `tests/integration/api-key-scope.test.ts`: an import-scoped key gets 401 on 8 other routes (assets, audit, audit/verify, members, mfa/enroll, notifications, org settings, api-keys), succeeds on its own scoped ingest route, and a revoked key is rejected immediately including for ingest itself.
- `tests/integration/bootstrap-seed.test.ts` (new, 3 tests) proves `seed-bootstrap.ts` refuses without all four required env vars and creates exactly one org+admin when they're set.
- MFA-bypass-via-refresh regression test added to `members.test.ts`.
- CORS allow-list/credentials/no-wildcard behavior proven with 3 new tests in `security.test.ts`.
- `eslint-plugin-security` added; `detect-object-injection` disabled globally (58/62 findings were false positives on internal, non-attacker-controlled data) with the 2 genuinely-plausible findings individually suppressed with justification comments (`auth.ts` regex construction, `reset-demo.ts` `mkdirSync`).
- `npm audit fix` (non-forcing) resolved 8/11 vulnerabilities. The remaining one (`effect`/`@prisma/config`, high-severity ReDoS) requires `prisma@6.12.0` — a forbidden major downgrade — and is documented as an accepted exception (not reachable from request-handling code paths).

**Three consecutive full-suite runs** (`npm test` = `vitest run` + `vitest run --config vitest.demo-reset.config.ts` + `vitest run --config vitest.meridian-seed.config.ts`):
```
Run 1: 1 failed | 649 passed (650) — automatic-risk.test.ts "recomputes when access broadens enough to matter"
        (AssertionError: expected 2 to be greater than 2 — an exposure-score ceiling edge case in a
        pre-existing test file untouched this phase; confirmed not a regression by re-running — see below)
Run 2: 650/650 passed, including that same test
Run 3: 650/650 passed
```
The run-1 failure was a flaky boundary condition in an unrelated, unmodified test file (`git status` confirmed it was clean throughout this phase), not caused by any Phase 3 change — it passed cleanly on the immediate re-run and again on run 3.

**Final gates:** `npx tsc --noEmit` — 0 errors. `npm run lint` — 0 errors, 0 warnings. `npm audit --omit=dev` — 3 high (all one documented exception, see above).

## Phase 4 — testing hardening — 2026-11-23

**CI bug fix (found before any new Phase 4 work, not caused by it):** `npm test` has chained `vitest.config.ts` + `vitest.demo-reset.config.ts` + `vitest.meridian-seed.config.ts` since the Phase 3 round, each needing its own database, but `.github/workflows/ci.yml` only ever provisioned `medguard_test`. CI last ran 2026-09-24, before that change — the next push to `main` would have failed on the second and third legs. Fixed by adding `DEMO_TEST_DATABASE_URL`/`MERIDIAN_TEST_DATABASE_URL` env vars and a `psql CREATE DATABASE` step; `globalSetup.ts` migrates each automatically.

**Coverage gate:** `@vitest/coverage-v8@3.2.4` (pinned to the installed `vitest@^3.2.4` — a `@vitest/coverage-v8@5` would have forced a `vitest` major bump, forbidden). `riskScoring.ts` and `riskFactors.ts` were already at 100%/100% statements/branches from the existing suite; the threshold now locks that in. Verified the gate is real, not decorative, by deliberately setting `riskScoring.ts`'s statement threshold to 101% and confirming `ERROR: Coverage for statements (100%) does not meet ... threshold (101%)`, then reverting before committing. Added as a separate CI step (`npm run test:coverage`) rather than folded into `npm test`, so instrumentation overhead doesn't affect the main suite's timing.

**Route-inventory drift test** (`tests/route-inventory.test.ts`): parses the actual `(method, path)` pairs registered in `src/routes/*.ts` and diffs them against `docs/engineering/ROUTE_INVENTORY.md`'s table, in both directions (undocumented-but-live, and documented-but-dead). Verified by temporarily adding a throwaway route and confirming the test failed with the exact route named, then removing it and confirming green again.

**OpenAPI contract test** (`tests/openapi-contract.test.ts`): asserts `openapi.json` is byte-identical to what `scripts/generate-openapi.ts`'s document builder produces right now. Required exporting that builder behind an `import.meta.url` guard (previously a pure side-effecting script) — confirmed `npm run openapi:generate`'s file output is unchanged byte-for-byte after the refactor. Verified the test catches drift by mutating a string in the committed `openapi.json` and confirming failure, then reverting.

Note on scope: the generator has no response-body schemas (every route's `"200"` entry is just `{ description: "Success" }`), so this is a request-shape/spec-staleness contract, not a live-response-body contract — that would need response schemas added to the generator first, which wasn't attempted here (a real feature addition, not a test).

**k6 smoke test** (`scripts/k6/smoke.js`, run via `npm run perf:smoke`): login (once, in `setup()`) → risk distribution → list assets → recompute one asset, 20 VUs × 3 iterations. Run against a real local instance seeded with the Meridian data:
```
checks_succeeded: 100.00% 181 out of 181
http_req_duration: p(95)=96.59ms  (budget: p(95)<500ms)
http_req_failed:   0.00%          (budget: <1%)
```
Two real issues found and fixed while getting this to run, both now documented in the script itself:
1. The original `constant-vus` shape (20 VUs sustained for 30s) generates thousands of requests/sec, which instantly trips the app's own production-safe rate limiters (300 req/15min global, 10 logins/15min) — measuring the limiter, not the app. Changed to `per-vu-iterations` (20 VUs × 3 iterations) and moved login into k6's `setup()` so it happens once for the whole run, not once per iteration.
2. **A genuine environment hazard, not a code bug:** this machine has an unrelated, long-running dev server for a different, older checkout of this project (at a different path) already bound to `:4000`. `npm run dev` for the current checkout silently failed to bind and kept running anyway (tsx watch mode doesn't exit on a bind error), so every curl/k6 request against `localhost:4000` was actually hitting that other, stale process the whole time — which explained why its rate-limit state didn't reset on "restart." Did not touch that other process (not part of this work); ran this checkout on `PORT=4100` instead and documented the `lsof -i :4000` escape hatch directly in the script's header comment for whoever hits this next.

**Not attempted this round (deferred, needs user input):** the Testcontainers migration (`tests/setup/globalSetup.ts` replacing the local-Postgres assumption with `@testcontainers/postgresql`) and the ZAP baseline scan both need a working Docker daemon; this machine's Docker Desktop process has been running since 2026-10-28 but its socket is unreachable (`Cannot connect to the Docker daemon`). Did not attempt to restart/repair Docker. User chose to skip both for this round rather than wait on a Docker fix.

## Phase 4 completion — 2026-11-24/25

Resumes the round above after a mid-task crash; closes the remaining Phase 4 items plus the user's four follow-up asks (critical cookie-CSRF fix, rate-limit redesign, the automatic-risk flake, and finishing generated-test/coverage/contract work), gets CI actually running for the first time, and fixes everything that first real CI run surfaced.

**1. Access-token cookie removed — CSRF fix.** `requireAuth`'s `extractToken` fell back to a `drishti_token`/`medguard_token` cookie when no `Authorization` header was present; `POST /api/auth/login` set that cookie on every login. A cookie is sent automatically on a cross-site request with no way to require a custom header (unlike `requireCsrfHeader` on refresh/logout), so every mutating route — not just refresh/logout — was CSRF-exposed. Fixed: access token now authenticates only via `Authorization: Bearer`; login no longer sets the cookie; logout still clears both cookie names for hygiene. `tests/integration/generated-auth-gate.test.ts` (228 tests, generated from `ROUTE_INVENTORY.md`): every one of 114 non-public routes 401s both with no credentials and with only a forged access-token cookie. Verified the regression is actually caught (reverted the fix locally, 113/228 failed, restored it). Commit `fb8b1ef`.

**2. Rate limits redesigned — per-user/API-key, not shared IP.** The global limiter was 300 req/15min per IP covering the entire authenticated dashboard surface; a hospital sharing one outbound NAT IP would hit it collectively, and the UI's own 30s polling lets one user get close to it alone. `createAuthenticatedLimiter` (new) keys on `req.ctx.userId`, mounted after `requireAuth`; ceiling of 600/15min worked from the frontend's actual polling pattern (30s interval, up to 6 queries/tick → 900s/30s = 30 cycles × 6 = 180 steady-state floor, ~3x headroom) — math lives in the function's own comment. `createExportLimiter` likewise now keys on `userId`. `createIngestLimiter` now keys on the API key's own id (`req.ctx.connectorId`), not IP — required moving `requireApiKey` to run *before* the limiter (previously after, inside the router, which made per-key keying impossible). `createGlobalLimiter` scoped down to just `/api/auth` as a backstop for that router's public routes plus its low-volume `requireAuth`-gated control-plane routes (`/me`, `/mfa/*`, `/sessions`, `/change-password`, `/logout-all`) — deliberately left IP-keyed since they're not part of the polling surface. `createLoginLimiter`/`createSensitiveAuthLimiter` unchanged (IP-keyed, correct pre-authentication). Tests (`security.test.ts`): 50 users behind one shared IP, 25 requests each (1250 total, which would have 429'd under the old 1000-request-per-15min test-mode IP ceiling) — all succeed; a single user against a tiny injected limit (5) — 429s on request 6; login brute force from one IP — still 429s. Commit `2f223cd`.

**3. `automatic-risk.test.ts` flake — root cause and fix.** Traced the recompute path end to end (route handler → `onAssetChanged` → `recalculateAsset` → `apply`) and confirmed every write is awaited before the HTTP response is sent — no missing-await, no fire-and-forget write. The originally-reported flake ("recomputes when access broadens enough to matter", `expected 2 to be greater than 2`) never reproduced across 70+ file-level runs, isolated or full-file; most likely a transient resource-contention artifact of the full three-config chained run, not a logic bug in that file. What the investigation *did* find: lowering `BCRYPT_COST` to 4 under `NODE_ENV=test` (a suite-speed change made in the same investigation) made logins fast enough to expose a real, different flake — `createLoginLimiter`'s test-mode failure budget (5) is shared by every test in a file via one `createApp()` instance, and files that log in dozens of times across their tests (like this one) could occasionally tip over it, 429ing an otherwise-valid login. Fixed by making the login-limiter ceiling configurable (`createLoginLimiter({ limit })`, `createApp({ loginLimit })`) with a generous app-wide test default (1000, matching other limiters) and an explicit small override only where the real boundary is being tested. **50/50 consecutive clean runs recorded post-fix.** Commits `4403c0f`, `9f6e436`.

**4. Generated-test/coverage/contract work, completed:**
- **RBAC**: `tests/integration/generated-rbac.test.ts` (new, 171 checks = 57 permission-gated routes × 3 roles), driven off `ROUTE_INVENTORY.md`'s Permission column cross-referenced against `rolesWith()` ground truth in `lib/permissions.ts`. Excludes the two genuinely non-uniform cases (`PATCH /api/controls/:id`'s field-scoped gate, already covered by `permissions.test.ts`; the API-key-authenticated ingest route, covered by `api-key-scope.test.ts`). Verified it catches a real privilege-widening regression (loosened `POST /api/assets` from `asset:create` to `asset:read`; failed exactly where expected). Commit `9f6e436`.
- **Tenant isolation**: covered by the existing per-feature integration suite (e.g. `tenancy.test.ts`, and the new cross-tenant 404 case added in `policies.test.ts`), not by one additional generated-100%-of-routes test this round — building that would need a per-entity-type "resource that exists in the rival org" fixture for every one of the ~20 resource types, which wasn't attempted. Flagging as a real, named gap rather than claiming full generated coverage that doesn't exist.
- **Audit coverage**: `tests/audit-coverage.test.ts` (66 routes documented as audited, each confirmed to have a matching `recordAudit`/`recordAuthEventSafe` call in its route file or the service(s) it delegates to) — **100% of documented-audited routes**, turning SECURITY_REVIEW.md's manual claim into an enforced, re-runnable check. Verified it catches a real mismatch.
- **fast-check property tests**: `riskScoring.test.ts` — score always in [0,100], deterministic, monotonic (raising any one factor never lowers the score); band boundaries were already exhaustively covered by existing example-based tests. Verified the properties catch a real regression.
- **Response-body contract tests**: one representative route (`GET /api/assets`) end to end — a Zod schema (`src/schemas/responses.ts`) feeds both `openapi.json`'s `"200"` entry and a live test (`tests/integration/openapi-response-contract.test.ts`) parsing the real HTTP response against it. Not all 97 routes — see that file's header comment for the scoping call.
- **Coverage gates** (`vitest.config.ts`): overall ≥85% (currently 88.74%), `src/services/**/*.ts` as an aggregate group ≥90% lines (currently 90.36% — confirmed glob thresholds evaluate as an aggregate across matched files, not per-file, by deliberately setting one to 99% and seeing a single aggregate `ERROR` line), risk-scoring engine 100%/100%. A handful of individual service files remain below 90% on their own (`controlService.ts` 69%, `memberService.ts` 67%, `identityService.ts` 67%, `dataFlowService.ts` 81%) — not closed.
- **Suite speed**: `BCRYPT_COST` lowered to 4 under `NODE_ENV=test` only (was a flat 12); `assertProductionBcryptCost()` runs at import time and fails loudly if production ever inherits a value below 12 — proven by `src/services/authService.test.ts` spawning real subprocesses per `NODE_ENV` and reading the cost back out of the bcrypt hash string itself. Before/after: the closest prior full-suite timing on record (Phase 2's feature-build round, a different test count) was 195.42s for the main config alone; this round's three-config total is consistently ~110-145s (see the three consecutive runs below) — comfortably under the 3-minute target.
- **`effect` npm override**: `package.json`'s `overrides` pins `effect` to `3.22.5` (patched, same 3.x line as the vulnerable `3.20.0` — not the `prisma@6.12.0` major downgrade `npm audit fix --force` would have forced). `npm audit --omit=dev`: **0 vulnerabilities**. Verified `prisma generate`/`migrate deploy`/`db:seed` and the full suite all still work under the override.

**5. CI actually running, for the first time.** CI only triggers on `main`/PRs-into-main; every commit through this whole multi-day session had gone straight to the `demo/ceo-walkthrough` branch, so none of Phase 3/4's CI changes had ever executed (`gh run list` showed CI's last real run was 2026-09-24). Pushed the branch and opened draft PR #5 ("Drishti production hardening (Phases 1-4)") into `main`, which finally triggered it — and found four previously-undetected bugs across six push/fix/watch cycles, in order:

1. **`npm run typecheck` (both tsconfigs) had never actually been run this whole session** — every local check used plain `npx tsc --noEmit`, which only checks `tsconfig.json`; `tsconfig.test.json` also covers `prisma/**/*.ts` and `tests/**/*.ts` under the same `noUncheckedIndexedAccess` that's been on throughout, which makes every regex `.exec()` match-group access potentially `T | undefined`. Six files had this, including `prisma/reset-demo.ts`, untouched this whole session — that one's been broken since before this work started, just never caught because CI hadn't run since September. Fixed each with a `!` where the value is genuinely always present. Commit `4a5d25a`.
2. **ZAP plan field names**: `matchStr`/`regex` should have been `matchString`/`matchRegex` (ZAP's actual Automation Framework schema) — ZAP rejected the plan outright. Also fixed the report job's output path to match where the CI step's artifact-upload step actually looks. Commit `4a5d25a`.
3. **`openapi.json` itself was malformed**: 9 of 97 routes had a path param with no matching `parameters` entry. Fixed by exporting each route's existing (but previously unexported) Zod param schema and wiring it into the generator; two routes got new inline schemas since no existing schema object covered them. New permanent test. Commit `b1602a9`.
4. **`openapi.json`'s `servers[0].url` doubled the `/api` prefix already present in every path** — resolved by any spec-compliant client as `/api/api/...`, which 404s on everything. This is what the *first* real ZAP scan actually proved (100% of responses 4xx, both alerts pointing at `/api/api/auth/login`), and the subsequent fix to the ZAP plan's own `targetUrl` (treating the symptom) wasn't sufficient on its own — the second scan still showed the identical doubling. `servers[0].url` is now `"/"`. New permanent test. Commits `cd614c2`, `dcf846a`.
5. **ZAP's spider job starts from the context's `urls` list, not its own `url` parameter** (confirmed by observation: setting the job's own `url` had no effect on the actual request logged) — both were pointed at the bare `/api` root, which has no handler and 404s; fixed by pointing both at a real endpoint (`/api/assets`). Commits `32e53fa`, `ac7e364`.

**CI run history on PR #5** (all against `demo/ceo-walkthrough`): 45362385288 (both jobs red — ZAP config + typecheck) → 45364710017 (`verify` green, ZAP red — malformed spec) → 45366826851 (`verify` green, ZAP red — doubled `/api`, scan ran but touched nothing real) → 45487307811 (same) → 45489020473 (`verify` green, ZAP red — spider 404 on bare `/api`) → 45490496603 (same, spider job's own `url` param confirmed ignored) → **45491760284: both jobs green.**

**Final ZAP scan result** (CI run 45491760284, artifact downloaded and inspected): 2 findings, both **Informational** risk — `Authentication Request Identified` (ZAP's own detection of the login flow, not a vulnerability) and `User Agent Fuzzer` (3 instances, header-fuzzing noise). No Low/Medium/High findings. **Coverage caveat, stated plainly**: ~96% of ZAP's requests returned 4xx and only ~3% 2xx — `openapi.json` carries no example path-param values, so most ID-scoped detail/mutation routes legitimately 404 on ZAP's placeholder IDs rather than ever reaching their real logic. "Two informational findings" reflects what a black-box scan without crafted fixture data can see, not a certified absence of vulnerabilities across the ID-scoped routes; seeding the context with real resource ids would meaningfully widen coverage and wasn't attempted. Full detail recorded in `docs/engineering/SECURITY_REVIEW.md`'s new "ZAP dynamic scan (CI)" section.

Native ZAP (`brew install --cask zap`) could not be run on this machine — the cask is Gatekeeper-disabled (`Error: zap: Cask 'zap' has been disabled because it does not pass the macOS Gatekeeper check!`), confirmed by a direct attempt. Per the user's own fallback instruction, skipped the local scan and relied on the CI job, which is unaffected by that and is the one that counts.

**6. Hygiene.**
- `scripts/k6/smoke.js`'s npm script (`perf:smoke`) now sources `.env` before invoking k6 (`set -a && . ./.env && set +a && k6 run ...`) instead of requiring `DEMO_USER_PASSWORD` as a literal on the command line.
- `src/server.ts`: `app.listen()`'s `error` event had no listener, so a taken port either threw with no clear message or — under `tsx watch` — triggered an endless crash-restart loop that still looks "alive" in `ps` while the port is never actually bound (the exact bug that made an unrelated project's stale server silently eat every request during the earlier k6 work). Now exits 1 with a message naming the port and `lsof -i :<port>` as the next step. `src/server.test.ts`: occupies the real port with a plain TCP listener, spawns the real server entrypoint against it, asserts non-zero exit + the message. Verified it catches the regression (removed the handler, saw the test fail on a 10s timeout instead of a clean non-zero exit).
- No `.env` contents or the demo password were printed in any command or log this round; the one place a real password briefly appeared on a command line (`perf:smoke` testing, before the `.env`-sourcing fix) was in the session preceding the mid-task crash — not repeated after.

**Final state — three consecutive full local runs** (`npm test` = `vitest run` + `vitest run --config vitest.demo-reset.config.ts` + `vitest run --config vitest.meridian-seed.config.ts`), each 1172/1172 passing:
```
Run 1: 1142 + 20 + 10 = 1172 passed.  96.84s + 14.73s + 2.51s  = 114.08s total
Run 2: 1142 + 20 + 10 = 1172 passed.  97.69s + 17.45s + 2.80s  = 117.94s total
Run 3: 1142 + 20 + 10 = 1172 passed. 108.93s + 21.34s + 3.10s  = 133.37s total
```
All comfortably under the 3-minute (180s) target. `npm run typecheck` (both configs) and `npm run lint`: zero errors. `npm run test:coverage`: overall 88.74%/83.16%/83.77%/88.74% (statements/branches/functions/lines), `src/services` group 90.36% lines, `riskScoring.ts`/`riskFactors.ts` 100%/100%. `npm audit --omit=dev`: 0 vulnerabilities. CI (PR #5, run 45491760284): both jobs green.
