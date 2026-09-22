import type { Request } from "express";
import type { AuditAction, AuditResult } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { TenantContext } from "../lib/tenant.js";

/**
 * The only writer of AuditEvent.
 *
 * Everything that changes customer data goes through here, and the table is
 * append-only by convention: nothing in this codebase updates or deletes an
 * audit row.
 *
 * Two rules the type system cannot enforce, so they are enforced here instead:
 *
 * 1. **No credentials, tokens or PHI in metadata.** `sanitiseMetadata` drops
 *    keys that look like secrets outright. It is a backstop, not permission to
 *    be careless at the call site.
 * 2. **An audited write and its audit row share a transaction.** Pass the
 *    transaction client as `db` and the two commit or roll back together, so
 *    there is no state where the change happened and the record of it did not.
 */

/** Minimal shape both `prisma` and a `$transaction` client satisfy. */
type AuditDb = { auditEvent: { create: (args: { data: AuditRow }) => Promise<unknown> } };

type AuditRow = {
  organizationId: number | null;
  actorUserId: number | null;
  actorEmail: string | null;
  action: AuditAction;
  entityType: string | null;
  entityId: number | null;
  result: AuditResult;
  metadata: object | undefined;
  ip: string | null;
  userAgent: string | null;
};

/**
 * Keys never written to the audit trail, matched case-insensitively as
 * substrings. `ssn`, `dob` and `mrn` are here because audit metadata describes
 * *what changed*, and a field name is enough — the patient identifier that
 * changed is PHI and has no business in a log.
 */
const FORBIDDEN_KEY_PATTERNS = [
  "password", "passwordhash", "token", "secret", "authorization", "cookie",
  "apikey", "api_key", "credential", "ssn", "dob", "mrn", "patient",
];

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Recursively strips forbidden keys and truncates long strings. Returns
 * undefined for an empty result so the column stays NULL rather than `{}`.
 */
export function sanitiseMetadata(value: unknown, depth = 0): object | undefined {
  if (depth > 4 || value === null || typeof value !== "object") return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (raw === null || raw === undefined) {
      out[key] = null;
    } else if (typeof raw === "string") {
      out[key] = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw;
    } else if (raw instanceof Date) {
      out[key] = raw.toISOString();
    } else if (Array.isArray(raw)) {
      out[key] = raw.slice(0, 50).map((v) =>
        typeof v === "object" && v !== null ? sanitiseMetadata(v, depth + 1) ?? null : v,
      );
    } else if (typeof raw === "object") {
      out[key] = sanitiseMetadata(raw, depth + 1) ?? null;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export type AuditInput = {
  action: AuditAction;
  entityType?: string;
  entityId?: number;
  result?: AuditResult;
  metadata?: unknown;
  /** Request, purely for IP and user agent. Never read for auth. */
  req?: Request;
};

/** Truncated because a hostile client controls it and the column is unbounded. */
function userAgentOf(req: Request | undefined): string | null {
  const ua = req?.get("user-agent");
  return ua ? ua.slice(0, 300) : null;
}

function ipOf(req: Request | undefined): string | null {
  return req?.ip ?? null;
}

/**
 * Records an action taken by a known caller inside an organisation.
 *
 * Pass `db` as the surrounding `$transaction` client whenever one exists, so
 * the audit row cannot survive a rolled-back change or vice versa.
 */
export async function recordAudit(
  ctx: TenantContext,
  input: AuditInput,
  db: AuditDb = prisma,
): Promise<void> {
  await db.auditEvent.create({
    data: {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      result: input.result ?? "SUCCESS",
      metadata: sanitiseMetadata(input.metadata),
      ip: ipOf(input.req),
      userAgent: userAgentOf(input.req),
    },
  });
}

/**
 * Records an authentication event, where there may be no session yet and
 * therefore no TenantContext — a failed login is the whole point of this
 * variant, and it has no verified actor by definition.
 *
 * `actorEmail` is whatever the caller typed. It is stored as an attempted
 * identifier, not as an assertion that the account exists; treating it as the
 * latter would turn the audit trail into an account-enumeration oracle for
 * anyone who could read it.
 */
export async function recordAuthEvent(input: {
  action: AuditAction;
  actorEmail: string | null;
  actorUserId?: number | null;
  organizationId?: number | null;
  result?: AuditResult;
  metadata?: unknown;
  req?: Request;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail,
      action: input.action,
      entityType: "User",
      entityId: input.actorUserId ?? null,
      result: input.result ?? "SUCCESS",
      metadata: sanitiseMetadata(input.metadata),
      ip: ipOf(input.req),
      userAgent: userAgentOf(input.req),
    },
  });
}

/**
 * Best-effort variant for the one case where failing the request would be
 * worse than losing the record: an authentication attempt that is already
 * being rejected. If the audit insert fails here, the login still fails — the
 * caller is not let in — and the failure is surfaced on stderr.
 *
 * Used *only* for that path. Every data mutation uses `recordAudit`, which
 * throws, because a write whose audit row did not land must not stand.
 */
export async function recordAuthEventSafe(
  input: Parameters<typeof recordAuthEvent>[0],
): Promise<void> {
  try {
    await recordAuthEvent(input);
  } catch (err) {
    console.error(
      `[drishti] audit write failed for ${input.action}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Field-level before/after, for update metadata.
 *
 * Only keys present in `after` are compared, so a PATCH that touched three
 * fields records three changes rather than the whole row. Unchanged fields are
 * omitted entirely — "what changed" is the question the trail has to answer.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const [key, next] of Object.entries(after)) {
    if (next === undefined) continue;
    const prev = before[key];

    const same =
      prev instanceof Date && next instanceof Date
        ? prev.getTime() === next.getTime()
        : prev === next;

    if (!same) {
      changes[key] = {
        from: prev instanceof Date ? prev.toISOString() : prev ?? null,
        to: next instanceof Date ? next.toISOString() : next,
      };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}
