import { prisma } from "../lib/prisma.js";
import { BadRequestError } from "../lib/errors.js";
import { computeRisk } from "./riskScoring.js";
import { parseCsv, type ParsedRow, type RowError } from "./importParsing.js";
import type { EntitySpec, RefTarget } from "./importSpec.js";

/**
 * The database half of CSV import: everything parseCsv cannot decide on its
 * own — does this asset exist, is this row already in the table — plus the
 * commit itself.
 *
 * Both endpoints run the identical pipeline. /validate stops after the report;
 * /import continues into a single transaction. Sharing the path is the point:
 * a dry run that checked less than the real thing would be worthless.
 */

export type ImportReport = {
  valid: boolean;
  totalRows: number;
  errors: RowError[];
  preview: Record<string, unknown>[];
};

const PREVIEW_ROWS = 10;

/** Prisma client for a transaction, or the bare client outside one. */
type Db = Pick<typeof prisma, "asset" | "pHIType" | "identity" | "dataFlow" | "accessGrant" | "threat" | "risk" | "vendor">;

/**
 * Reference tables are loaded whole rather than queried key by key. They are
 * small (an estate has tens of PHI types, not millions), it is one query
 * instead of N, and it lets the match be case-insensitive — which matters
 * because a human typing "epic ehr core" means the same system as the file
 * that says "Epic EHR Core".
 */
async function loadRefIndex(db: Db, target: RefTarget): Promise<Map<string, number>> {
  const index = new Map<string, number>();

  if (target === "Asset") {
    for (const r of await db.asset.findMany({ select: { id: true, name: true } })) {
      index.set(r.name.toLowerCase(), r.id);
    }
    return index;
  }

  if (target === "PHIType") {
    for (const r of await db.pHIType.findMany({ select: { id: true, name: true } })) {
      index.set(r.name.toLowerCase(), r.id);
    }
    return index;
  }

  // Identity.displayName carries no unique constraint, so an ambiguous name
  // must fail rather than silently pick one. A duplicated name maps to -1,
  // which resolveRefs reports as ambiguous.
  const seen = new Map<string, number>();
  for (const r of await db.identity.findMany({ select: { id: true, displayName: true } })) {
    const key = r.displayName.toLowerCase();
    seen.set(key, seen.has(key) ? -1 : r.id);
  }
  return seen;
}

/** Which ref targets this entity actually uses. */
function refTargets(spec: EntitySpec): RefTarget[] {
  return [...new Set(spec.columns.flatMap((c) => (c.ref ? [c.ref.target] : [])))];
}

/**
 * Turns every natural-key column into the foreign key Prisma needs. Rows whose
 * references do not resolve are dropped from `resolved` and reported instead,
 * so a later stage never sees a half-built row.
 */
async function resolveRefs(
  db: Db,
  spec: EntitySpec,
  rows: ParsedRow[],
  rowNumbers: number[],
): Promise<{ resolved: Record<string, unknown>[]; keptIndices: number[]; errors: RowError[] }> {
  const indexes = new Map<RefTarget, Map<string, number>>();
  for (const target of refTargets(spec)) {
    indexes.set(target, await loadRefIndex(db, target));
  }

  const errors: RowError[] = [];
  const resolved: Record<string, unknown>[] = [];
  const keptIndices: number[] = [];

  rows.forEach((row, i) => {
    const out: Record<string, unknown> = {};
    let ok = true;

    for (const col of spec.columns) {
      const value = row[col.column];

      if (!col.ref) {
        // Blank optional columns are omitted so the schema default applies.
        if (value !== null && col.field) out[col.field] = value;
        continue;
      }

      const index = indexes.get(col.ref.target);
      const id = index?.get(String(value).toLowerCase());

      if (id === undefined) {
        errors.push({
          row: rowNumbers[i] ?? 0,
          field: col.column,
          message: `No ${col.ref.target} found named "${String(value)}". Create it first, then re-import.`,
        });
        ok = false;
        continue;
      }
      if (id === -1) {
        errors.push({
          row: rowNumbers[i] ?? 0,
          field: col.column,
          message: `More than one ${col.ref.target} is named "${String(value)}" — cannot tell which is meant.`,
        });
        ok = false;
        continue;
      }
      out[col.ref.foreignKeyField] = id;
    }

    if (ok) {
      resolved.push(out);
      keptIndices.push(i);
    }
  });

  return { resolved, keptIndices, errors };
}

/**
 * Rejects rows that already exist. The natural key per entity is documented in
 * IMPORT_GUIDE.md and mirrors the unique constraint where the schema has one.
 */
async function existingRecordErrors(
  db: Db,
  spec: EntitySpec,
  resolved: Record<string, unknown>[],
  rowNumbers: number[],
  originalRows: ParsedRow[],
): Promise<RowError[]> {
  const errors: RowError[] = [];
  const clash = (i: number, label: string) =>
    errors.push({
      row: rowNumbers[i] ?? 0,
      field: spec.naturalKey.join(" + "),
      message: `${spec.model} "${label}" already exists, matched on ${spec.naturalKeyLabel}. Import only adds new records.`,
    });

  switch (spec.slug) {
    case "assets": {
      const names = resolved.map((r) => String(r.name));
      const existing = new Set(
        (await db.asset.findMany({ select: { name: true } })).map((r) => r.name.toLowerCase()),
      );
      names.forEach((n, i) => { if (existing.has(n.toLowerCase())) clash(i, n); });
      break;
    }
    case "phi-types": {
      const existing = new Set(
        (await db.pHIType.findMany({ select: { name: true } })).map((r) => r.name.toLowerCase()),
      );
      resolved.forEach((r, i) => {
        const n = String(r.name);
        if (existing.has(n.toLowerCase())) clash(i, n);
      });
      break;
    }
    case "vendors": {
      const existing = new Set(
        (await db.vendor.findMany({ select: { name: true } })).map((r) => r.name.toLowerCase()),
      );
      resolved.forEach((r, i) => {
        const n = String(r.name);
        if (existing.has(n.toLowerCase())) clash(i, n);
      });
      break;
    }
    case "data-flows": {
      const existing = new Set(
        (await db.dataFlow.findMany({ select: { sourceAssetId: true, targetAssetId: true, phiTypeId: true } }))
          .map((r) => `${r.sourceAssetId}:${r.targetAssetId}:${r.phiTypeId}`),
      );
      resolved.forEach((r, i) => {
        if (existing.has(`${String(r.sourceAssetId)}:${String(r.targetAssetId)}:${String(r.phiTypeId)}`)) {
          clash(i, String(originalRows[i]?.sourceAssetName ?? "") + " -> " + String(originalRows[i]?.targetAssetName ?? ""));
        }
      });
      break;
    }
    case "access-grants": {
      const existing = new Set(
        (await db.accessGrant.findMany({ select: { identityId: true, assetId: true } }))
          .map((r) => `${r.identityId}:${r.assetId}`),
      );
      resolved.forEach((r, i) => {
        if (existing.has(`${String(r.identityId)}:${String(r.assetId)}`)) {
          clash(i, String(originalRows[i]?.identityName ?? ""));
        }
      });
      break;
    }
    case "threats": {
      const existing = new Set(
        (await db.threat.findMany({ select: { assetId: true, title: true } }))
          .map((r) => `${r.assetId}:${r.title.toLowerCase()}`),
      );
      resolved.forEach((r, i) => {
        if (existing.has(`${String(r.assetId)}:${String(r.title).toLowerCase()}`)) {
          clash(i, String(r.title));
        }
      });
      break;
    }
    case "risks": {
      // A Risk row is the current assessment for an asset. Importing a second
      // one would quietly create a competing record, so it is refused; use
      // POST /api/risks/:assetId/recompute to rescore instead.
      const existing = new Set((await db.risk.findMany({ select: { assetId: true } })).map((r) => r.assetId));
      resolved.forEach((r, i) => {
        if (existing.has(Number(r.assetId))) clash(i, String(originalRows[i]?.assetName ?? ""));
      });
      break;
    }
  }

  return errors;
}

/** Sorted so a user reads the report top-to-bottom as they scroll the file. */
function byRowThenField(a: RowError, b: RowError): number {
  return a.row !== b.row ? a.row - b.row : a.field.localeCompare(b.field);
}

/**
 * The shared pipeline. Returns the report plus the rows ready for insert, so
 * the import endpoint does not have to validate twice.
 */
async function analyse(
  db: Db,
  spec: EntitySpec,
  text: string,
): Promise<{ report: ImportReport; insertable: Record<string, unknown>[] }> {
  const parsed = parseCsv(spec, text);

  const empty = (errors: RowError[]): { report: ImportReport; insertable: Record<string, unknown>[] } => ({
    report: { valid: false, totalRows: parsed.totalRows, errors: errors.sort(byRowThenField), preview: [] },
    insertable: [],
  });

  if (parsed.errors.length > 0 && parsed.rows.length === 0) return empty(parsed.errors);

  const { resolved, keptIndices, errors: refErrors } =
    await resolveRefs(db, spec, parsed.rows, parsed.rowNumbers);

  // Index-aligned with `resolved`, so a duplicate found on the third surviving
  // row still reports the line that row actually came from.
  const keptRowNumbers = keptIndices.map((i) => parsed.rowNumbers[i] ?? 0);
  const keptOriginals = keptIndices.map((i) => parsed.rows[i] ?? {});

  const dupErrors = await existingRecordErrors(db, spec, resolved, keptRowNumbers, keptOriginals);
  const errors = [...parsed.errors, ...refErrors, ...dupErrors].sort(byRowThenField);

  // Preview shows the file as parsed — natural keys, not resolved ids, because
  // that is what the user typed and can compare against.
  const preview = parsed.rows.slice(0, PREVIEW_ROWS).map((r) => ({ ...r }));

  return {
    report: { valid: errors.length === 0, totalRows: parsed.totalRows, errors, preview },
    insertable: errors.length === 0 ? resolved : [],
  };
}

/** Dry run. Touches the database only to read. */
export async function validateImport(spec: EntitySpec, text: string): Promise<ImportReport> {
  const { report } = await analyse(prisma, spec, text);
  return report;
}

/** Turns validated rows into Prisma creates for one entity. */
async function insertRows(db: Db, spec: EntitySpec, rows: Record<string, unknown>[]): Promise<number> {
  switch (spec.slug) {
    case "assets":
      return (await db.asset.createMany({ data: rows as never })).count;
    case "phi-types":
      return (await db.pHIType.createMany({ data: rows as never })).count;
    case "vendors":
      return (await db.vendor.createMany({ data: rows as never })).count;
    case "data-flows":
      return (await db.dataFlow.createMany({ data: rows as never })).count;
    case "access-grants":
      return (await db.accessGrant.createMany({ data: rows as never })).count;
    case "threats":
      return (await db.threat.createMany({ data: rows as never })).count;
    case "risks": {
      // score and band are derived here, by the same function riskEngine uses,
      // so an imported assessment lands identical to one scored through the
      // API. No band is accepted from the file at all.
      const scored = rows.map((r) => {
        const { score, band } = computeRisk(
          Number(r.likelihood), Number(r.impact), Number(r.exposure), Number(r.controlGap),
        );
        return { ...r, score, band };
      });
      return (await db.risk.createMany({ data: scored as never })).count;
    }
    default:
      throw new BadRequestError(`Unsupported entity "${spec.slug}"`);
  }
}

export type ImportResult = ImportReport & { imported: number };

/**
 * Real import. Validates and commits inside one transaction, so a file either
 * lands whole or not at all — including the re-check, which runs against the
 * transaction's own view rather than a snapshot taken beforehand.
 */
export async function runImport(spec: EntitySpec, text: string): Promise<ImportResult> {
  return prisma.$transaction(async (tx) => {
    const { report, insertable } = await analyse(tx as unknown as Db, spec, text);
    if (!report.valid) return { ...report, imported: 0 };

    const imported = await insertRows(tx as unknown as Db, spec, insertable);
    return { ...report, imported };
  });
}
