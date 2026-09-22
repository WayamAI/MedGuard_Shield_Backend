import { z } from "zod";

/**
 * Offset pagination, shared by every list endpoint.
 *
 * Offset rather than cursor: the frontend's tables are page-numbered and need
 * a total count to render "page 3 of 12", which a cursor cannot give. At the
 * scale this product addresses -- tens of thousands of rows per tenant, not
 * millions -- the cost of OFFSET is not the bottleneck. Revisit if a single
 * tenant's access register ever outgrows that.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/**
 * Query schema for a paginated endpoint. Both fields are optional so an
 * existing caller that passes nothing still works and gets page 1.
 *
 * `pageSize` is capped rather than rejected above the maximum: a client asking
 * for 10,000 rows gets 200, which is friendlier than a 400 and still bounds
 * the query.
 */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

export type PaginationInput = z.infer<typeof paginationQuery>;

export type PageParams = { skip: number; take: number; page: number; pageSize: number };

export function pageParams(input: PaginationInput): PageParams {
  const page = input.page ?? 1;
  const pageSize = Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

export type PageMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Paginated<T> = { items: T[]; meta: PageMeta };

/**
 * Builds the `meta` sibling that rides alongside `data` in a list response.
 * `totalPages` is at least 1 so an empty result still reads as "page 1 of 1"
 * rather than "page 1 of 0".
 */
export function pageMeta(params: PageParams, total: number): PageMeta {
  return {
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

/** Sort direction, shared by the list endpoints that accept one. */
export const sortOrder = z.enum(["asc", "desc"]);
