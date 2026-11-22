# Gap Audit

Performed 2026-11-22 against commit `bfc5027` (branch `demo/ceo-walkthrough`), by running the stack locally (native Postgres, not Docker — see note below) and reading every route/service/middleware file plus `prisma/schema.prisma`.

## Headline: this repo is considerably more production-ready than a "prototype" label suggests

Several things the task brief assumed were missing already exist, cleanly built:
- Structured error envelope (`{error:{code,message,...}}`) — already in `src/middleware/errorHandler.ts`, including body-parser-specific translations and secret-safe logging.
- Liveness/readiness split — `GET /health` and `GET /health/ready` already do what `/healthz`/`/readyz` were asked to do (rename is cosmetic, not a new feature).
- Helmet, CORS allow-list (no wildcard, `credentials:true` respected), global + login-specific rate limiting, 100kb body limit, `trust proxy` — all present in `src/app.ts` / `src/middleware/security.ts`.
- RBAC is a genuine permission matrix (`src/lib/permissions.ts`), not per-route role arrays, including a field-level ANALYST exception on controls (`ANALYST_CONTROL_FIELDS`) matching ground-rule-10 exactly.
- Tenant isolation is centralized (`src/lib/tenant.ts`'s `scope(ctx)`), with `TenantContext` carrying `organizationId` from the verified session only — by code shape, not just convention.
- Audit coverage is complete: every one of 47 mutating handlers has a matching `recordAudit`/`recordAuthEventSafe` call (verified by diffing mutation-count vs. audit-call-count per route file — all equal or audit-higher, never lower).
- `docker-compose.yml` already has a proper `migrate` one-shot service running `prisma migrate deploy`, separate from the dev-only `prisma migrate dev`.

This changes the shape of Phases 1–3: much of that work is "confirm and document," not "build."

## What's missing or partial (maps to Phase 2 of the plan)

| Feature | Status | Notes |
|---|---|---|
| OpenAPI spec | **Missing** | No `openapi.json`, no `/api/docs`. Zod 4 schemas exist per-route but aren't registered anywhere. |
| PDF/CSV reports | **Missing** | Only `GET /api/reports/risk-assessment` (JSON) exists. |
| PHI inventory endpoint | **Missing** | `PHIType`/`AssetPHI` models exist and are used internally (risk exposure factors), but no `GET /api/phi-inventory` surfaces them. |
| Members (Drishti user) lifecycle | **Missing** | No invite/accept/password-reset/MFA/session-list endpoints. `User`/`OrganizationMember`/`RefreshToken` models exist; `authService.ts` only covers login/refresh/logout. |
| Org settings (configurable thresholds) | **Missing** | `STALE_AFTER_DAYS` and similar constants are hardcoded in services (e.g. `accessService.ts`), not per-org configurable. |
| Notifications | **Missing** | No `Notification` model or endpoints. |
| Scheduled jobs | **Missing** | No cron/job runner; nothing currently re-evaluates time-based staleness except on-demand recompute triggers. |
| CSV exports | **Missing** | No `?format=csv` or `.csv` sibling routes on any list endpoint. |
| Ingestion API (API keys) | **Missing** | No `ApiKey` model; `POST /api/import/:entity` exists but requires a logged-in admin, not a scoped key. |
| Audit immutability enforcement | **Missing** | `AuditEvent` is append-only *by convention* (no route/service path updates or deletes one), but nothing stops a raw SQL `UPDATE`/`DELETE` — no DB trigger, no restricted DB role. No hash chain. |
| Config validation at boot | **Missing** | `.env` is read via `dotenv`/`process.env` directly; no Zod schema validates it fails fast with a clear message (though `JWT_SECRET` already has an explicit length check per its `.env` comment — confirm in code). |
| Structured JSON logging | **Partial** | Errors are logged server-side (`console.error`, deliberately not echoing DB errors), but there's no pino/request-ID middleware or systematic redaction beyond what `errorHandler.ts` already avoids leaking. |
| Graceful shutdown | **Unverified** | Not found in `src/app.ts`; `src/server.ts` not yet read in this pass — check for a `SIGTERM` handler before assuming it's missing. |

## Corrections needed to existing docs

- **Endpoint count**: `API_REFERENCE.md`, `DRISHTI_BACKEND_FINAL_REPORT.md`, and `README.md` all claim **87 endpoints**. The actual count, read directly from the routers mounted in `src/app.ts`, is **65 route handlers under `/api` + 2 public health probes = 67**. These docs should be corrected in Phase 5, not left as an aspirational/stale figure.
- **Demo login accounts**: ground-rule-8's claimed demo logins (`admin@meridian.org` etc.) are correct and match `prisma/seed.ts` exactly, verified by querying the seeded `medguard_dev` database directly (e.g. Billing Engine DB: likelihood 5/impact 5/exposure 5/controlGap 5 → score 100.00, band EXTREME, phiVolume 87100, encrypted=false — confirmed via `psql`). Per your explicit instruction, `admin@wayam.ai` / `analyst@wayam.ai` / `viewer@wayam.ai` were added as additional login aliases on the same Meridian org in `prisma/seed.ts` (same roles, same shared `DEMO_USER_PASSWORD`) — they did not exist anywhere in the codebase before this change. A separate, pre-existing seed (`prisma/seed-demo.ts` / `npm run db:seed:demo`) targets an unrelated org ("Drishti Demo Healthcare") with throwaway `.invalid` emails; it is not part of the Meridian CEO-walkthrough demo and should not be confused with it.

## Bugs / invariant risks found

None found that violate the 14 product invariants. Specifically checked and clean:
- No route missing a permission check where one should exist (every POST/PATCH/PUT/DELETE across all 16 route files carries `requirePermission`/a custom equivalent like `canPatchControl`, except public auth endpoints and health probes, which is correct).
- No service bypassing `scope(ctx)` found in the files read this pass (assets, access, controls, import, permissions, tenant helpers). A full line-by-line audit of every service for `organizationId` scoping is still worth doing in Phase 2 as new code is added nearby, but nothing contradicts the pattern so far.
- Risk engine math matches ground-rule-3/4 exactly in the one asset spot-checked (Billing Engine DB, raw 625 → 100.00 EXTREME).

## Environment notes (not product bugs, but relevant to Phase 0/1/4 execution)

- **Local dev uses a native Homebrew Postgres, not the Docker Compose stack.** `.env`'s `DATABASE_URL` points at `localhost:5432` with no password (trust auth), independent of `POSTGRES_PASSWORD`/`POSTGRES_USER`/`POSTGRES_DB` in the same file, which are *docker-compose-only* and were left empty. Running `docker compose up` as the plan originally assumed fails on a missing `POSTGRES_PASSWORD` until that's set — not attempted in this pass since the native stack was already running and seeded. Phase 5's "`docker compose up` from a clean clone" verification must set `POSTGRES_PASSWORD` (e.g. via `.env` or `--env-file`) before it will work; this is a documentation/onboarding gap more than a code bug.
- `tests/integration/demo-reset.test.ts` (9 of its tests) failed when run against `medguard_test`, because `prisma/reset-demo.ts` has its own safety guard requiring the target DB name contain "demo" — `medguard_test` doesn't. This is the reset script's own deliberate safety check working as designed against an environment naming mismatch, not a demo-reset bug. **554/572 tests passed; the only failures are these 9 demo-reset cases** (see `VERIFICATION.md`). Resolve in Phase 1 by either renaming the test DB to include "demo" (risky — would weaken the test-truncation guard in `globalSetup.ts`, which requires "test") or giving `reset-demo.ts` a test-mode escape hatch recorded as a deliberate decision, not a silent override.
- No Testcontainers currently in use; the suite relies on a real, name-guarded Postgres (local or CI-provisioned) instead. Functionally equivalent for CI purposes — Phase 4 should decide whether to adopt Testcontainers or keep this convention, and document the choice rather than replacing a working pattern by default.
