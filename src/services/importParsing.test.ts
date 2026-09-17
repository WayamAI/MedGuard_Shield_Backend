import { describe, expect, it } from "vitest";
import { buildCsv, escapeCsvValue, naturalKeyOf, parseCsv, templateCsv } from "./importParsing.js";
import { specFor } from "./importSpec.js";

/**
 * Pure parsing rules, no database. Everything here is decidable from the file
 * alone — reference resolution and duplicate-against-the-table live in
 * importService and are covered by the integration suite.
 */

const assets = specFor("assets")!;
const risks = specFor("risks")!;
const threats = specFor("threats")!;
const flows = specFor("data-flows")!;

const ASSET_HEADER = "name,type,phiVolume,encrypted,mfaEnabled,lastAssessedAt";

describe("templateCsv", () => {
  it("emits the header row followed by one example row", () => {
    const lines = templateCsv(assets).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(ASSET_HEADER);
    expect(lines[1]).toContain("Epic EHR Core");
  });

  it("produces a template that parses cleanly through its own validator", () => {
    for (const slug of ["assets", "phi-types", "data-flows", "vendors", "access-grants", "threats", "risks"]) {
      const spec = specFor(slug)!;
      const result = parseCsv(spec, templateCsv(spec));
      expect(result.errors, `${slug} template should self-validate`).toEqual([]);
      expect(result.rows).toHaveLength(1);
    }
  });
});

describe("escapeCsvValue", () => {
  it.each(["=SUM(A1:A9)", "+1+1", "-2+3", "@SUM(1)", "\tx", "\rx"])(
    "prefixes %j so a spreadsheet treats it as text",
    (value) => {
      // A value needing quotes is wrapped first, so the guard quote sits just
      // inside the opening quote rather than at position 0.
      const cell = escapeCsvValue(value).replace(/^"/, "");
      expect(cell.startsWith("'")).toBe(true);
    },
  );

  it("quotes values containing a comma, quote or newline", () => {
    expect(escapeCsvValue("A, Inc")).toBe('"A, Inc"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
  });

  it("leaves ordinary values untouched", () => {
    expect(escapeCsvValue("Epic EHR Core")).toBe("Epic EHR Core");
  });

  it("round-trips an escaped formula back through the parser as inert text", () => {
    const csv = buildCsv(["name", "type"], [["=cmd()", "API"]]);
    const parsed = parseCsv(specFor("assets")!, csv);
    // The written cell is "'=cmd()", which no longer leads with "=".
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.name).toBe("'=cmd()");
  });
});

describe("parseCsv — headers", () => {
  it("rejects a missing required column against row 1", () => {
    const { errors } = parseCsv(assets, "name,phiVolume\nEpic,100\n");
    expect(errors).toContainEqual({
      row: 1, field: "type", message: 'Missing required column "type"',
    });
  });

  it("rejects an unknown column and names the valid ones", () => {
    const { errors } = parseCsv(assets, "name,type,colour\nEpic,EHR,blue\n");
    expect(errors[0]?.row).toBe(1);
    expect(errors[0]?.field).toBe("colour");
    expect(errors[0]?.message).toContain("Unknown column");
  });

  it("does not also emit row-level noise when the header is wrong", () => {
    const { errors } = parseCsv(assets, "wrong\na\nb\nc\n");
    expect(errors.every((e) => e.row === 1)).toBe(true);
  });

  it("rejects an empty file", () => {
    const { errors, totalRows } = parseCsv(assets, "");
    expect(totalRows).toBe(0);
    expect(errors[0]?.message).toBe("File contains no data rows");
  });

  it("rejects a header-only file", () => {
    const { errors } = parseCsv(assets, `${ASSET_HEADER}\n`);
    expect(errors[0]?.message).toBe("File contains no data rows");
  });

  it.each([
    ["CRLF throughout", "\r\n"],
    ["LF throughout", "\n"],
    ["CR throughout", "\r"],
  ])("reads a file with %s", (_label, eol) => {
    const csv = [ASSET_HEADER, "A,EHR,1,true,true,", "B,API,2,true,true,"].join(eol) + eol;
    const { errors, rows } = parseCsv(assets, csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  /**
   * A template downloaded from the API is CRLF; rows appended in a text editor
   * are usually LF. Auto-detection locks onto the first ending it sees and
   * then merges every later line into one over-wide record.
   */
  it("reads a file whose header and rows use different line endings", () => {
    const csv = `${ASSET_HEADER}\r\nA,EHR,1,true,true,\nB,API,2,true,true,\n`;
    const { errors, rows } = parseCsv(assets, csv);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
  });

  it("tolerates a UTF-8 BOM, which Excel writes by default", () => {
    const { errors, rows } = parseCsv(assets, `\uFEFF${ASSET_HEADER}\nEpic,EHR,1,true,true,\n`);
    expect(errors).toEqual([]);
    expect(rows[0]?.name).toBe("Epic");
  });
});

describe("parseCsv — row numbering", () => {
  it("numbers the first data row 2, matching the line number in a spreadsheet", () => {
    const { errors } = parseCsv(assets, `${ASSET_HEADER}\nEpic,NOPE,1,true,true,\n`);
    expect(errors[0]?.row).toBe(2);
  });

  it("numbers the third data row 4", () => {
    const csv = `${ASSET_HEADER}\nA,EHR,1,true,true,\nB,API,1,true,true,\nC,NOPE,1,true,true,\n`;
    const { errors } = parseCsv(assets, csv);
    expect(errors[0]?.row).toBe(4);
  });
});

describe("parseCsv — rowNumbers stay tied to the source line", () => {
  it("reports the true line for rows that survive after an earlier row failed", () => {
    const csv =
      `${ASSET_HEADER}\n` +
      "Good,API,1,true,true,\n" +      // line 2, kept
      "Bad,MAINFRAME,1,true,true,\n" + // line 3, dropped
      "Also Good,EHR,2,true,true,\n";  // line 4, kept
    const { rows, rowNumbers } = parseCsv(assets, csv);

    expect(rows.map((r) => r.name)).toEqual(["Good", "Also Good"]);
    // Naively recomputing from the surviving index would give [2, 3] and send
    // the user to the wrong line.
    expect(rowNumbers).toEqual([2, 4]);
  });

  it("stays aligned when the dropped row is a duplicate rather than a type error", () => {
    const csv =
      `${ASSET_HEADER}\n` +
      "A,API,1,true,true,\n" +  // line 2
      "A,EHR,1,true,true,\n" +  // line 3, duplicate, dropped
      "B,EHR,2,true,true,\n";   // line 4
    const { rows, rowNumbers } = parseCsv(assets, csv);
    expect(rows).toHaveLength(2);
    expect(rowNumbers).toEqual([2, 4]);
  });

  it("is index-aligned with rows in the ordinary case", () => {
    const csv = `${ASSET_HEADER}\nA,API,1,true,true,\nB,EHR,2,true,true,\n`;
    const { rows, rowNumbers } = parseCsv(assets, csv);
    expect(rowNumbers).toHaveLength(rows.length);
    expect(rowNumbers).toEqual([2, 3]);
  });
});

describe("parseCsv — field coercion", () => {
  const row = (overrides: Partial<Record<string, string>> = {}) => {
    const base: Record<string, string> = {
      name: "Epic", type: "EHR", phiVolume: "100",
      encrypted: "true", mfaEnabled: "false", lastAssessedAt: "2026-08-14",
    };
    const merged = { ...base, ...overrides };
    const cols = ["name", "type", "phiVolume", "encrypted", "mfaEnabled", "lastAssessedAt"];
    return `${ASSET_HEADER}\n${cols.map((c) => merged[c] ?? "").join(",")}\n`;
  };

  it("coerces a well-formed row into typed values", () => {
    const { errors, rows } = parseCsv(assets, row());
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ name: "Epic", type: "EHR", phiVolume: 100, encrypted: true, mfaEnabled: false });
    expect(rows[0]?.lastAssessedAt).toBeInstanceOf(Date);
  });

  it("treats a blank optional column as null so the schema default applies", () => {
    const { rows } = parseCsv(assets, row({ phiVolume: "", lastAssessedAt: "" }));
    expect(rows[0]?.phiVolume).toBeNull();
    expect(rows[0]?.lastAssessedAt).toBeNull();
  });

  it("rejects a blank required column", () => {
    const { errors } = parseCsv(assets, row({ name: "" }));
    expect(errors[0]).toMatchObject({ row: 2, field: "name", message: "name is required" });
  });

  it.each([["abc"], ["1.5"], ["1e3"], ["12abc"]])("rejects %j as an integer", (bad) => {
    const { errors } = parseCsv(assets, row({ phiVolume: bad }));
    expect(errors[0]?.field).toBe("phiVolume");
  });

  it("enforces a minimum", () => {
    const { errors } = parseCsv(assets, row({ phiVolume: "-1" }));
    expect(errors[0]?.field).toBe("phiVolume");
  });

  it("enforces a maximum", () => {
    const csv = "assetName,likelihood,impact,exposure,controlGap\nEpic,6,3,3,3\n";
    const { errors } = parseCsv(risks, csv);
    expect(errors[0]).toMatchObject({ field: "likelihood", message: "likelihood must be at most 5" });
  });

  it.each([["true", true], ["TRUE", true], ["yes", true], ["1", true],
           ["false", false], ["no", false], ["0", false]])(
    "reads %j as %s", (input, expected) => {
      const { rows } = parseCsv(assets, row({ encrypted: String(input) }));
      expect(rows[0]?.encrypted).toBe(expected);
    },
  );

  it("rejects a non-boolean", () => {
    const { errors } = parseCsv(assets, row({ encrypted: "maybe" }));
    expect(errors[0]?.field).toBe("encrypted");
  });

  it("accepts an enum in any case and stores it uppercase", () => {
    const { errors, rows } = parseCsv(assets, row({ type: "cloud_storage" }));
    expect(errors).toEqual([]);
    expect(rows[0]?.type).toBe("CLOUD_STORAGE");
  });

  it("rejects an enum value outside the set and lists the options", () => {
    const { errors } = parseCsv(assets, row({ type: "MAINFRAME" }));
    expect(errors[0]?.message).toContain("EHR");
  });

  it.each([["14/08/2026"], ["2026-8-14"], ["Aug 14 2026"], ["2026-13-01"]])(
    "rejects %j as a date", (bad) => {
      const { errors } = parseCsv(assets, row({ lastAssessedAt: bad }));
      expect(errors[0]?.field).toBe("lastAssessedAt");
    },
  );

  it("parses a valid date as UTC midnight so it cannot shift a day by timezone", () => {
    const { rows } = parseCsv(assets, row({ lastAssessedAt: "2026-08-14" }));
    expect((rows[0]?.lastAssessedAt as Date).toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("enforces maxLength", () => {
    const { errors } = parseCsv(assets, row({ name: "x".repeat(121) }));
    expect(errors[0]?.message).toContain("exceeds 120 characters");
  });

  it("keeps a quoted comma inside one field", () => {
    const csv = `${ASSET_HEADER}\n"Acme, Inc",EHR,1,true,true,\n`;
    const { errors, rows } = parseCsv(assets, csv);
    expect(errors).toEqual([]);
    expect(rows[0]?.name).toBe("Acme, Inc");
  });

  it("reports every bad field in a row, not just the first", () => {
    const { errors } = parseCsv(assets, row({ type: "NOPE", phiVolume: "abc", encrypted: "maybe" }));
    expect(errors.map((e) => e.field).sort()).toEqual(["encrypted", "phiVolume", "type"]);
  });
});

describe("parseCsv — formula injection", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)"])("rejects a text cell starting with %j", (bad) => {
    const { errors } = parseCsv(assets, `${ASSET_HEADER}\n${bad},EHR,1,true,true,\n`);
    expect(errors[0]?.field).toBe("name");
    expect(errors[0]?.message).toContain("formula");
  });

  it("rejects a formula in a natural-key reference column too", () => {
    const csv = "assetName,likelihood,impact,exposure,controlGap\n=evil(),3,3,3,3\n";
    const { errors } = parseCsv(risks, csv);
    expect(errors[0]?.field).toBe("assetName");
  });

  it("still allows a negative number in a numeric column", () => {
    // phiVolume has min 0 so -1 fails on bounds, not on the formula rule.
    const { errors } = parseCsv(assets, `${ASSET_HEADER}\nEpic,EHR,-1,true,true,\n`);
    expect(errors[0]?.message).toContain("at least 0");
  });

  it("never evaluates a cell — a formula string stays a string when escaped", () => {
    const csv = `${ASSET_HEADER}\n"'=SUM(1)",EHR,1,true,true,\n`;
    const { errors, rows } = parseCsv(assets, csv);
    expect(errors).toEqual([]);
    expect(rows[0]?.name).toBe("'=SUM(1)");
  });
});

describe("parseCsv — duplicate natural keys inside one file", () => {
  it("rejects a repeated single-column key and points at the first use", () => {
    const csv = `${ASSET_HEADER}\nEpic,EHR,1,true,true,\nEpic,API,2,true,true,\n`;
    const { errors, rows } = parseCsv(assets, csv);
    expect(rows).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 3, message: expect.stringContaining("row 2") });
  });

  it("matches the key case-insensitively", () => {
    const csv = `${ASSET_HEADER}\nEpic,EHR,1,true,true,\nEPIC,API,2,true,true,\n`;
    expect(parseCsv(assets, csv).errors).toHaveLength(1);
  });

  it("uses the composite key for threats (asset + title)", () => {
    const header = "assetName,severity,status,title,description,detectedAt,resolvedAt";
    const same = "Billing,HIGH,OPEN,Same title,desc,,";
    const { errors } = parseCsv(threats, `${header}\n${same}\n${same}\n`);
    expect(errors[0]?.message).toContain("Duplicate");
  });

  it("allows the same asset twice in threats when titles differ", () => {
    const header = "assetName,severity,status,title,description,detectedAt,resolvedAt";
    const csv = `${header}\nBilling,HIGH,OPEN,One,desc,,\nBilling,LOW,OPEN,Two,desc,,\n`;
    expect(parseCsv(threats, csv).errors).toEqual([]);
  });

  it("uses the three-part key for data flows", () => {
    const header = "sourceAssetName,targetAssetName,phiTypeName,recordsPerDay,encrypted";
    const csv = `${header}\nA,B,Clinical,10,true\nA,B,Clinical,20,true\n`;
    expect(parseCsv(flows, csv).errors[0]?.message).toContain("Duplicate");
  });

  it("allows the same pair of assets with a different PHI type", () => {
    const header = "sourceAssetName,targetAssetName,phiTypeName,recordsPerDay,encrypted";
    const csv = `${header}\nA,B,Clinical,10,true\nA,B,Financial,20,true\n`;
    expect(parseCsv(flows, csv).errors).toEqual([]);
  });
});

describe("naturalKeyOf", () => {
  it("joins the key columns case-insensitively", () => {
    expect(naturalKeyOf(threats, { assetName: "Billing", title: "Leak" }))
      .toBe(naturalKeyOf(threats, { assetName: "BILLING", title: "leak" }));
  });
});
