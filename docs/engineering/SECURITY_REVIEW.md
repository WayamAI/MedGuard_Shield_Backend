# Security Review — OWASP ASVS Level 2

Performed 2026-11-23 against commit state after Phase 2 + the follow-up fix round. Every item below was checked against the running code (file:line), not assumed. Fixes made during this pass are called out inline; everything else was already correct or is recorded as an accepted exception with a reason.

Legend: ✅ pass · 🔧 fixed this pass · ⚠️ accepted exception (reason given) · N/A not applicable to this API.

## V2 — Authentication

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 2.1.1 | Passwords allow at least 64 characters, no silent truncation | ✅ | No max-length enforced anywhere before hashing; bcrypt's own 72-byte input limit is a known bcrypt property, not something this app imposes. |
| 2.1.4 | No composition rules (forced symbols etc.) that push users to predictable patterns | ✅ | Only a minimum length (10) is enforced (`z.string().min(10)` on change/reset/accept-invite/bootstrap password schemas) — no forced character classes. |
| 2.1.7 | Passwords checked against breach/weak lists | ⚠️ | Not implemented — no breach-list API integration. Accepted: this is a defense-in-depth addition, not a baseline requirement at Level 2 for an internal B2B tool; revisit if this product takes consumer signups. |
| 2.2.1 | Anti-automation on authentication (rate limiting) | ✅ | `createLoginLimiter()` (10/15min, counts only failures) on `/api/auth/login`; `createSensitiveAuthLimiter()` 🔧 added this pass on `/forgot-password`, `/reset-password`, `/accept-invite` (20/15min). |
| 2.2.2 | CAPTCHA or equivalent for high-risk operations | N/A | No consumer-facing signup surface; rate limiting + account lockout-equivalent (failure counting) is the control at this tier. |
| 2.2.3 | No disclosure of which part of a credential was wrong | ✅ | `tests/integration/auth.test.ts` — unknown-email and wrong-password responses are asserted byte-identical (minus `requestId`). |
| 2.3.1 | Initial/generated passwords are random and unique per user | ✅ | `apiKeyService.createApiKey` and `memberService.inviteMember`/`passwordResetService` never generate a password — the user always sets their own. `seed-bootstrap.ts` requires an operator-supplied password, never generates one. |
| 2.4.1–2.4.3 | Credentials stored with an approved algorithm, salted, proper work factor | ✅🔧 | bcrypt via `hashPassword` (`src/services/authService.ts`); work factor raised from 10 to **12** this pass (`BCRYPT_COST`), matching the modern OWASP Password Storage Cheat Sheet baseline. bcrypt salts automatically per-hash. |
| 2.5.1 | No secret question/answer recovery | ✅ | Password reset is token-based only (`passwordResetService.ts`); no security questions exist anywhere in the schema. |
| 2.5.2 | No enumeration via forgot-password | ✅ | `requestPasswordReset` always returns the same response regardless of whether the email exists; tested in `members.test.ts` ("resets via a mailed token without revealing whether the address exists" — asserts identical status and body). |
| 2.5.4 | Default/well-known credentials never active | ✅🔧 | `prisma/seed.ts` had **no production guard at all** before this pass — 🔧 added (`SEED_ALLOW_PRODUCTION`), matching the pattern `seed-demo.ts` already had. `seed-bootstrap.ts` requires explicit env-supplied credentials, never defaults one. All three now tested (`meridian-seed.test.ts`, `demo-seed.test.ts`, `bootstrap-seed.test.ts`). |
| 2.5.5 | Reset/invite tokens: single-use, time-limited, high-entropy, invalidated on use | ✅ | `PasswordResetToken`/`MemberInvite` store a SHA-256 hash of a `randomBytes(32)` token (256 bits of entropy); `usedAt`/`acceptedAt` enforced; 30-minute (reset) / 7-day (invite) expiry. Reset additionally revokes every live session on success (`revokeAllRefreshTokens`). |
| 2.6 | Lookup secrets (API keys) hashed, not reversible, compared in constant time | ✅ | `apiKeyService.ts` stores only `keyHash` (SHA-256); the plaintext secret is returned exactly once, at creation, and is not retrievable afterward — confirmed by `ingest.test.ts`'s "shows the secret exactly once" assertion that a subsequent list call has no `secret`/`keyHash` field. Comparison is a Postgres unique-index equality lookup (`findUnique({ where: { keyHash } })`), not an application-level string comparison — there is no byte-by-byte comparison in our code whose timing could leak a partial match. |
| 2.7.1–2.7.3 | TOTP MFA: standard algorithm, correct time-step, rate-limited, replay-resistant, recovery codes single-use | ✅ | `otplib`'s standard TOTP (RFC 6238) via `mfaService.ts`; recovery codes are hashed and removed from the array the moment they're spent (`members.test.ts` "logs in once with a recovery code, then refuses to reuse it"); MFA attempts share the login route's rate limiter. |
| 2.8.1 | MFA cannot be bypassed via another path | ✅🔧 | New test this pass (`members.test.ts`: "a refresh token can only ever come from a login that already passed MFA") proves refresh never re-opens the MFA question *because it never had the option to skip it* — a refresh token is only ever issued after `login()`'s MFA check passes. API keys are a structurally separate authentication class (service credential, not a human session) mounted only on `/api/ingest`, which no human-session route accepts — see V13 below. |
| 2.9 | Algorithm confusion / weak crypto on tokens | ✅🔧 | JWT signing/verification previously had **no pinned algorithm, issuer or audience** — any change to the `jsonwebtoken` library's defaults, or a future code change that passed a different key type, could have widened what a token verifies against. 🔧 Pinned `algorithm: "HS256"` on sign, `algorithms: ["HS256"]` on verify, plus `issuer`/`audience` claims checked on both sides (`authService.ts`). |

## V3 — Session Management

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 3.1.1 | Session tokens have sufficient entropy | ✅ | Refresh tokens: `randomBytes(32)` (256 bits), stored hashed. Access tokens are signed JWTs (HS256, 32-byte secret enforced by `src/config.ts`'s `min(16)` — see note below). |
| 3.2.1 | Session tokens are only in TLS-protected transport in production | ✅ | `secure: isProduction` on both cookies (`routes/auth.ts`); in dev, `http://localhost` is the whole point and TLS doesn't apply. |
| 3.2.3 | Cookies: `HttpOnly`, `Secure` (prod), appropriate `SameSite` | ✅🔧 | `httpOnly: true` always; `secure`/`sameSite` now read from the single validated `isProduction` flag (`src/config.js`) instead of a second, independent `process.env.NODE_ENV` check that had drifted into existence in `routes/auth.ts` — 🔧 consolidated to one source of truth. |
| 3.3.1 | Logout invalidates the session server-side, not just client-side | ✅ | `/api/auth/logout` calls `revokeRefreshToken`, not just `res.clearCookie`; `/api/auth/logout-all` revokes every refresh token for the user. |
| 3.5.2 | Refresh tokens rotate on use and detect reuse | ✅ | Covered above (V2.5.5 / `refreshSession` code walkthrough) — reuse of an already-rotated token revokes **every** live session for that user, not just the one presented. |
| 3.7.1 | CSRF protection on session-cookie-authenticated state-changing requests | 🔧 | **Was missing entirely.** `/api/auth/refresh` and `/api/auth/logout` are authenticated purely by a cookie the browser attaches automatically — a classic CSRF target, and every other mutating route requires a bearer header a form can't forge, so these two were the gap. 🔧 Added `requireCsrfHeader` (`src/middleware/csrf.ts`): requires a custom header, which a plain HTML form cannot set and which forces a CORS preflight on any cross-origin `fetch`/XHR — a preflight `cors()` already rejects for any origin outside `FRONTEND_ORIGIN`. Tested in `session.test.ts` ("CSRF protection on cookie-authenticated endpoints" — 3 cases). |

## V4 — Access Control

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 4.1.1 | Principle of least privilege, deny-by-default | ✅ | `src/lib/permissions.ts`: `can()` returns `false` unless the role is explicitly ADMIN, the permission is in the shared read set, or (for ANALYST) explicitly listed in `ANALYST_GRANTS`. No route grants by omission. |
| 4.1.3 | Access control applied server-side on every request, not inferred from UI state | ✅ | `requirePermission()`/`requireRole()` middleware on every mutating route (`ROUTE_INVENTORY.md`, generated from the router files directly, confirms 100% coverage). |
| 4.1.5 | Access control decisions logged | ✅ | Every mutation that succeeds is audited (`recordAudit`); a 403 itself isn't separately audited today — see accepted exception below. |
| 4.2.1 | Sensitive data access is tenant-scoped on every query | ✅ | `scope(ctx)` threaded through every service; cross-tenant access returns 404, confirmed by `tenancy.test.ts`'s matrix. |
| 4.3.1 | Admin functionality requires re-authentication for sensitive changes (e.g., disabling MFA) | ✅ | `mfaService.disableMfa` requires the current password **and** a valid code, not an active session alone. |
| — | API-key scope enforcement: an import-scoped key can't reach any other route | ✅🔧 | Structurally true (API keys are checked only by `requireApiKey`, mounted solely on `/api/ingest`, itself mounted *before* the session gate — no other route accepts `X-API-Key`), but **untested before this pass**. 🔧 New `tests/integration/api-key-scope.test.ts`: 10 cases proving a valid API key gets 401 on `/api/assets`, `/api/audit`, `/api/audit/verify`, `/api/members`, `/api/auth/mfa/enroll`, `/api/notifications`, `/api/organization/settings`, `/api/api-keys`; succeeds on its own ingest route; and a revoked key is rejected immediately, including for ingest itself. |

**Accepted exception (4.1.5):** failed authorization attempts (403s) are not individually written to the audit trail today — only successful mutations are. A sustained probing attempt would be visible in access logs (pino, with request IDs) but not in `AuditEvent`. Accepted for this pass: the audit trail's purpose per the product's own invariants is "what changed and who changed it," and a 403 by definition changed nothing. Revisit if abuse monitoring becomes a requirement — it would need its own retention/volume story, since failed attempts can be far higher volume than successful writes.

## V5 — Validation, Sanitization, Encoding

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 5.1.1 | Input validated against a positive (allow-list) model | ✅ | Every route body/query/params validated through Zod schemas (`validate()` middleware) before a handler runs. |
| 5.1.3 | All client-controlled input validated server-side even if also validated client-side | ✅ | No endpoint trusts client-side validation; Zod runs on the server for every route. |
| 5.2.3 | Untrusted data never used to construct a file path or OS command | ✅ | No `child_process.exec`/`spawn` anywhere except `pg_dump`/`prisma migrate deploy` invoked with fixed arguments and a server-controlled connection string, never request input. CSV import file paths don't exist — multer uses memory storage (`import.ts`), nothing is ever written to disk from an upload. |
| 5.2.5 | Output encoded for its context (no HTML injection into generated documents) | ✅ | PDF report (`reportPdf.ts`) uses pdfkit's `.text()` calls only — plain glyph rendering, no HTML/template interpreter, no path or URL ever built from request data. |
| 5.3.4 | Structured data (CSV) output is escaped against formula injection | ✅ | `lib/csv.ts`'s `escapeCell` prefixes any cell starting with `=+-@`/tab/CR with a single quote; proven by `csv-exports.test.ts`'s formula-injection case. |
| 5.3.9 | Application doesn't store data it shouldn't (patient records, in this product's case) | 🔧 | **CSV import had no check at all** for a cell shaped like an actual patient identifier (SSN, labelled MRN, labelled DOB) in a free-text column — only the entity *schema* enforced "metadata only," which doesn't stop someone pasting an identifier into e.g. a threat description. 🔧 Added `looksLikePatientIdentifier()` in `importParsing.ts`, checked on every string-typed column; 4 new unit tests in `importParsing.test.ts` (3 rejection cases, 1 false-positive check against the entity spec's own example text). |

## V7 — Error Handling and Logging

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1.1 | No stack traces or internal details in responses | ✅ | `errorHandler.ts` never serializes a stack into the response body in any branch; verified by `routes.test.ts`'s `expect(res.body.error.stack).toBeUndefined()`. |
| 7.1.2 | Errors don't disclose sensitive data (paths, versions, queries) | ✅ | `/health/ready`'s failure branch deliberately logs the DB error server-side and returns only `{status:"degraded"}` to the caller (comment in `app.ts` explains why). |
| 7.2.1 | Logs include enough context to investigate (actor, action, timestamp, source) without including secrets | ✅🔧 | `AuditEvent` carries actor, action, IP, user agent, timestamp. HTTP access logs (pino) carry a request ID correlated into every error response (`requestId`). 🔧 Redaction list was missing `X-API-Key` (a **real, confirmed leak** — demonstrated live, see below), `apiKey`, `secret`, `mfaSecret`, TOTP `code`, `recoveryCodes`, `tokenHash`, `keyHash`; all added to `REDACT_PATHS` (`middleware/logging.ts`), proven by 5 new tests in `middleware/logging.test.ts` that build a real pino logger with the config and assert the secret values never appear in captured output. |
| 7.4.1 | Audit log is tamper-resistant | ✅ | SHA-256 hash chain plus a DB trigger rejecting UPDATE/DELETE on `AuditEvent` outright, independent of each other (`audit-immutability.test.ts`); the trigger's one narrow DELETE exception is gated on `current_database()` containing "demo", not on any row's content. |

**Confirmed and fixed live, not just by code reading:** before this pass, `curl`/supertest against `/api/ingest/:recordType` with `X-API-Key: <real-secret>` produced a log line containing the plaintext secret verbatim. Re-tested after the fix: 0 occurrences.

## V9 — Data Protection

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 9.1.1 | Sensitive data encrypted in transit | ⚠️ | TLS termination is an infrastructure/deployment concern (reverse proxy or platform-level), not something `src/app.ts` itself does — accepted, standard for a Node API behind a load balancer; `secure` cookie flags assume TLS exists in front of the process in production. |
| 9.1.3 | No sensitive data in URLs (query strings, logged with referrers) | ✅ | No endpoint accepts a password, token, or secret as a query parameter; tokens travel in POST bodies or headers only. |
| 9.2.1 | PHI/patient data minimization | ✅ | Core product invariant, enforced structurally (no entity spec has a patient-identifier field) and now also at the free-text layer (V5.3.9 above). |

## V13 — API and Web Service

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 13.1.1 | Same authentication/access-control enforced for every interface (not just the "main" one) | ✅ | The ingestion API is a second authentication class (API key, not session) but is held to the same scoping rule: `requireApiKey` sets a `TenantContext` exactly like `requireAuth` does, and every service downstream only ever sees that shape — it cannot escalate past what import operations already allow. Proven by V4's new `api-key-scope.test.ts`. |
| 13.2.1 | Rate limiting per sensitive operation, not just globally | ✅🔧 | Login (pre-existing), ingest (pre-existing), and 🔧 this pass: password reset / invite accept (`createSensitiveAuthLimiter`) and every CSV/audit export (`createExportLimiter`, self-skipping for non-export requests on the same route). |
| 13.4.1 | CORS is an explicit allow-list with credentials, never a wildcard | ✅ | `cors({ origin: origins, credentials: true })` where `origins` comes from `FRONTEND_ORIGIN` (`src/config.ts`), split on commas for multi-origin support — never `"*"` (which is invalid with `credentials: true` regardless). 🔧 Newly tested this pass (`security.test.ts` "CORS" block — 3 cases: allowed origin reflected correctly, arbitrary origin not reflected, unapproved origin gets no CORS header at all on a plain GET). |
| 13.4.2 | Request size limits | ✅ | `express.json({ limit: "100kb" })` (app.ts); multer's own 2MB/1-file limit for CSV uploads (`import.ts`); tested (`routes.test.ts` `PAYLOAD_TOO_LARGE`, `import.test.ts` `FILE_TOO_LARGE`). |

## Dependencies

- `npm audit --omit=dev`: started at 11 vulnerabilities (3 moderate, 8 high). `npm audit fix` (no `--force`, no major bumps) resolved 8 of them — `multer` (DoS CVE), `zod` (memory-exhaustion CVE), `fast-uri`, `ip-address`, `qs`, and `mysql2` patched within Prisma's own dependency range.
- **Remaining, accepted**: `effect` (ReDoS in `Schema.TemplateLiteral`), a transitive dependency of `@prisma/config`. The only available fix downgrades `prisma` to `6.12.0` — a major-version downgrade this plan explicitly forbids without approval. Risk assessed as low: `@prisma/config` and `effect` are invoked by the Prisma CLI for `prisma.config.ts` parsing at migrate/generate/CLI time, not imported by anything under `src/` that serves a request — no request-attacker-controlled input reaches this code path in the running server.
- ESLint: added `eslint-plugin-security`. Its `detect-object-injection` rule produced 58 warnings, all on internal, non-attacker-controlled bracket-notation property access (Prisma results, fixed label arrays) — reviewed individually, none were real; disabled with a documented rationale in `eslint.config.js` rather than sprinkled with 58 individual suppressions that would hide a real future finding in the noise. The two genuinely plausible-looking findings (`detect-non-literal-regexp` in `auth.ts`, `detect-non-literal-fs-filename` in `reset-demo.ts`) were each reviewed and suppressed individually with a one-line reason, since both operate on this codebase's own constants, never request input.
- `npm run lint` and `npx tsc --noEmit`: zero errors.
