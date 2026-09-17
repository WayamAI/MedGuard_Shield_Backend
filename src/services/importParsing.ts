import { parse } from "csv-parse/sync";
import type { ColumnSpec, EntitySpec } from "./importSpec.js";

/**
 * CSV text in, validated rows out. No database access, so every rule here is
 * unit-testable on its own — the same separation riskScoring.ts has from
 * riskEngine.ts. Anything needing a lookup (does this asset exist?) lives in
 * importService.ts instead.
 */

export type RowError = { row: number; field: string; message: string };

/** A coerced row: column name -> value ready for Prisma, refs still unresolved. */
export type ParsedRow = Record<string, string | number | boolean | Date | null>;

export type ParseOutcome = {
  errors: RowError[];
  rows: ParsedRow[];
  /**
   * Source line of each entry in `rows`, index-aligned. Carried explicitly
   * because rows that fail coercion are dropped: recomputing the number from
   * the surviving index shifts every later row up by however many were
   * dropped before it, and misreports which line the user must go and fix.
   */
  rowNumbers: number[];
  totalRows: number;
};

/**
 * Row numbers are 1-based over the file as a whole, so the header is row 1 and
 * the first record is row 2. That matches the line number the user sees in
 * Excel, which is the only numbering they can act on.
 */
const FIRST_DATA_ROW = 2;

const TRUE_VALUES = new Set(["true", "yes", "y", "1"]);
const FALSE_VALUES = new Set(["false", "no", "n", "0"]);

/**
 * Leading characters Excel and Sheets treat as the start of a formula. A cell
 * beginning with one of these is refused rather than stored: MedGuard renders
 * these strings back into a UI and will eventually export them to CSV again,
 * and a value that becomes live code in someone's spreadsheet is not data.
 *
 * The cost is that a legitimate name starting with "-" is rejected too. That
 * is a deliberate trade and is documented in IMPORT_GUIDE.md.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

function looksLikeFormula(value: string): boolean {
  return FORMULA_PREFIXES.some((p) => value.startsWith(p));
}

/**
 * Escapes a value on the way *out* into a CSV we generate. Prefixing with a
 * single quote is what makes Excel treat the cell as text. Used by the
 * template endpoint so our own sample files cannot be the attack either.
 */
export function escapeCsvValue(value: string): string {
  const safe = looksLikeFormula(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(escapeCsvValue).join(",")).join("\r\n") + "\r\n";
}

/** The header row plus one realistic example row, for the template endpoint. */
export function templateCsv(spec: EntitySpec): string {
  return buildCsv(
    spec.columns.map((c) => c.column),
    [spec.columns.map((c) => c.example)],
  );
}

class CsvFormatError extends Error {}

function readRecords(text: string): Record<string, string>[] {
  try {
    return parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: false,
      // All three endings, explicitly. Left to auto-detect, csv-parse locks
      // onto whichever it meets first, so a file whose header came from one
      // tool and whose rows came from another silently merges lines into one
      // over-wide record. Real uploads are edited across Excel, Sheets and a
      // text editor, so mixed endings are the norm, not the exception.
      record_delimiter: ["\r\n", "\n", "\r"],
    }) as Record<string, string>[];
  } catch (err) {
    throw new CsvFormatError(err instanceof Error ? err.message : "Unreadable CSV");
  }
}

/**
 * Header check, before any row is looked at. A file with the wrong columns is
 * reported once against row 1 rather than producing the same error on every
 * line, which is what makes a 500-row mistake readable.
 */
function headerErrors(spec: EntitySpec, header: string[]): RowError[] {
  const errors: RowError[] = [];
  const seen = new Set(header);

  for (const col of spec.columns) {
    if (col.required && !seen.has(col.column)) {
      errors.push({ row: 1, field: col.column, message: `Missing required column "${col.column}"` });
    }
  }

  const known = new Set(spec.columns.map((c) => c.column));
  for (const h of header) {
    if (!known.has(h)) {
      errors.push({
        row: 1,
        field: h,
        message: `Unknown column "${h}". Expected one of: ${[...known].join(", ")}`,
      });
    }
  }

  return errors;
}

/** Coerces one cell. Returns either a value or the reason it is unusable. */
function coerce(
  col: ColumnSpec,
  raw: string,
): { ok: true; value: string | number | boolean | Date | null } | { ok: false; message: string } {
  const value = raw.trim();

  if (value === "") {
    if (col.required) return { ok: false, message: `${col.column} is required` };
    return { ok: true, value: null };
  }

  // Applied to text only. Numbers, dates, booleans and enums are parsed
  // strictly below, so a formula can never survive them anyway, and a numeric
  // field legitimately starts with "-".
  if ((col.type === "string" || col.ref) && looksLikeFormula(value)) {
    return {
      ok: false,
      message:
        `${col.column} starts with "${value[0]}", which spreadsheets treat as a formula. ` +
        "Remove the leading character.",
    };
  }

  switch (col.type) {
    case "string": {
      if (col.maxLength && value.length > col.maxLength) {
        return { ok: false, message: `${col.column} exceeds ${col.maxLength} characters` };
      }
      return { ok: true, value };
    }

    case "int": {
      if (!/^-?\d+$/.test(value)) {
        return { ok: false, message: `${col.column} must be a whole number, got "${value}"` };
      }
      const n = Number(value);
      if (col.min !== undefined && n < col.min) {
        return { ok: false, message: `${col.column} must be at least ${col.min}` };
      }
      if (col.max !== undefined && n > col.max) {
        return { ok: false, message: `${col.column} must be at most ${col.max}` };
      }
      return { ok: true, value: n };
    }

    case "boolean": {
      const lower = value.toLowerCase();
      if (TRUE_VALUES.has(lower)) return { ok: true, value: true };
      if (FALSE_VALUES.has(lower)) return { ok: true, value: false };
      return { ok: false, message: `${col.column} must be true or false, got "${value}"` };
    }

    case "date": {
      // Anchored to a date-only shape on purpose: accepting whatever Date()
      // happens to parse makes "03/04/2026" silently mean two different days
      // depending on who typed it.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, message: `${col.column} must be YYYY-MM-DD, got "${value}"` };
      }
      const d = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, message: `${col.column} is not a real date: "${value}"` };
      }
      return { ok: true, value: d };
    }

    case "enum": {
      const upper = value.toUpperCase();
      if (!col.values?.includes(upper)) {
        return {
          ok: false,
          message: `${col.column} must be one of: ${col.values?.join(", ")}. Got "${value}"`,
        };
      }
      return { ok: true, value: upper };
    }
  }
}

/** The natural-key string for a row, used for duplicate detection. */
export function naturalKeyOf(spec: EntitySpec, row: ParsedRow): string {
  return spec.naturalKey
    .map((c) => String(row[c] ?? "").toLowerCase())
    .join(" | ");
}

/**
 * Parses and validates everything that can be checked without the database:
 * headers, required fields, types, bounds, formula-looking text, and repeated
 * natural keys inside this one file.
 */
export function parseCsv(spec: EntitySpec, text: string): ParseOutcome {
  let records: Record<string, string>[];
  try {
    records = readRecords(text);
  } catch (err) {
    const message = err instanceof CsvFormatError ? err.message : "Unreadable CSV";
    return { errors: [{ row: 1, field: "file", message: `CSV could not be parsed: ${message}` }], rows: [], rowNumbers: [], totalRows: 0 };
  }

  if (records.length === 0) {
    return { errors: [{ row: 1, field: "file", message: "File contains no data rows" }], rows: [], rowNumbers: [], totalRows: 0 };
  }

  const header = Object.keys(records[0] ?? {});
  const headerIssues = headerErrors(spec, header);
  if (headerIssues.length > 0) {
    // Row-level checks against the wrong columns would be noise.
    return { errors: headerIssues, rows: [], rowNumbers: [], totalRows: records.length };
  }

  const errors: RowError[] = [];
  const rows: ParsedRow[] = [];
  const rowNumbers: number[] = [];
  const seenKeys = new Map<string, number>();

  records.forEach((record, index) => {
    const rowNumber = index + FIRST_DATA_ROW;
    const parsed: ParsedRow = {};
    let rowOk = true;

    for (const col of spec.columns) {
      const result = coerce(col, record[col.column] ?? "");
      if (result.ok) {
        parsed[col.column] = result.value;
      } else {
        errors.push({ row: rowNumber, field: col.column, message: result.message });
        rowOk = false;
      }
    }

    if (!rowOk) return;

    const key = naturalKeyOf(spec, parsed);
    const firstSeen = seenKeys.get(key);
    if (firstSeen !== undefined) {
      errors.push({
        row: rowNumber,
        field: spec.naturalKey.join(" + "),
        message: `Duplicate ${spec.naturalKeyLabel} within this file — already used on row ${firstSeen}`,
      });
      return;
    }

    seenKeys.set(key, rowNumber);
    rows.push(parsed);
    rowNumbers.push(rowNumber);
  });

  return { errors, rows, rowNumbers, totalRows: records.length };
}
