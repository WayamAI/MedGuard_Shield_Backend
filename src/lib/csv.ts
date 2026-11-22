/**
 * Minimal CSV writer, shared by every export endpoint.
 *
 * Hand-rolled rather than a dependency: the format is small enough (quote
 * fields containing a comma/quote/newline, double up embedded quotes) that a
 * library would add a dependency for a few lines, and the one behaviour that
 * actually matters here — formula-injection escaping — isn't something a
 * generic CSV writer does anyway.
 */

/**
 * A leading =, +, -, @, tab or CR makes some spreadsheet apps evaluate the
 * cell as a formula on open. Prefixing with a single quote defuses that
 * while keeping the value human-readable; Excel and Sheets both strip the
 * leading quote on display.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  let str = value === null || value === undefined ? "" : String(value);
  if (FORMULA_PREFIX.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
}

export type CsvColumn<T> = { header: string; value: (row: T) => unknown };

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCell(c.header)).join(",");
  const lines = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

type CsvCapableResponse = {
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
};

/**
 * Shared `?format=csv` handling for a list route. Called first in every
 * list handler below; returns `true` once it has written the CSV response
 * (the caller returns immediately), or `false` so the caller falls through
 * to its normal JSON response.
 */
export function maybeSendCsv<T>(
  req: { query: Record<string, unknown> },
  res: CsvCapableResponse,
  filename: string,
  rows: T[],
  columns: CsvColumn<T>[],
): boolean {
  if (req.query.format !== "csv") return false;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(toCsv(rows, columns));
  return true;
}
