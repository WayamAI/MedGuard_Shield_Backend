import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.js";

describe("toCsv", () => {
  it("quotes fields containing commas, quotes, or newlines", () => {
    const csv = toCsv([{ name: 'Say "hi", please\nnewline' }], [{ header: "name", value: (r) => r.name }]);
    expect(csv).toBe('name\r\n"Say ""hi"", please\nnewline"\r\n');
  });

  it("defuses formula-injection prefixes without altering the visible value", () => {
    const csv = toCsv([{ v: "=SUM(A1:A2)" }, { v: "+1" }, { v: "-1" }, { v: "@cmd" }], [
      { header: "v", value: (r) => r.v },
    ]);
    expect(csv).toBe("v\r\n'=SUM(A1:A2)\r\n'+1\r\n'-1\r\n'@cmd\r\n");
  });

  it("renders null/undefined as an empty cell", () => {
    expect(toCsv([{ v: null }, { v: undefined }], [{ header: "v", value: (r) => r.v }])).toBe("v\r\n\r\n\r\n");
  });
});
