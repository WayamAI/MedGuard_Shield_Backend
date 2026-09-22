import type { Role } from "../generated/prisma/client.js";

/**
 * Who is asking, and on whose behalf.
 *
 * Every service that touches customer data takes one of these as its first
 * argument. That is the whole tenancy mechanism: `organizationId` comes from
 * the verified session and never from the request body, query string or path,
 * so there is no code path where a caller can nominate the tenant they want to
 * read.
 *
 * Passing it explicitly rather than reading an ambient/async-local value is
 * deliberate. It makes an unscoped query a compile error at the call site
 * instead of a silent cross-tenant read at runtime.
 */
export type TenantContext = {
  /** The Drishti account making the request. */
  userId: number;
  email: string;
  /** Role *within this organisation*, from OrganizationMember. */
  role: Role;
  /** The tenant boundary. Every scoped query filters on this. */
  organizationId: number;
};

/**
 * The `where` fragment that scopes a query to the caller's organisation.
 *
 * Spread it into every `findMany`/`findFirst`/`updateMany` over a scoped
 * model:
 *
 *     prisma.asset.findMany({ where: { ...scope(ctx), archivedAt: null } })
 *
 * Reads that need a single record by id must use `findFirst` with this scope
 * rather than `findUnique`, because `findUnique` cannot express the extra
 * predicate and would happily return another tenant's row.
 */
export function scope(ctx: TenantContext): { organizationId: number } {
  return { organizationId: ctx.organizationId };
}
