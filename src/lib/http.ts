import type { Response } from "express";
import type { PageMeta } from "./pagination.js";

/**
 * Response envelopes, in one place so every endpoint is shaped identically.
 *
 * Single records and collections both carry `data`; collections add a `meta`
 * sibling. That keeps the existing contract -- clients already read `data` --
 * while giving paginated endpoints somewhere to put page counts.
 */

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data });
}

export function created<T>(res: Response, data: T): void {
  res.status(201).json({ data });
}

export function paged<T>(res: Response, items: T[], meta: PageMeta): void {
  res.json({ data: items, meta });
}
