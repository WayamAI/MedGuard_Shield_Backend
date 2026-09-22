import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor } from "../helpers.js";

/**
 * CSV import, end to end through Express, multer, validation and Prisma.
 *
 * The rules decidable from the file alone are unit-tested in
 * src/services/importParsing.test.ts. What is exercised here is everything
 * that needs a database: natural-key resolution, duplicate detection against
 * existing rows, RBAC, transaction atomicity, and file handling.
 */

const app = createApp();

let tokens: Record<"ADMIN" | "ANALYST" | "VIEWER", string>;
let ids: Awaited<ReturnType<typeof seedFixture>>;
/** An asset with no Risk row, so a risks import has somewhere to land. */
let unscoredAssetId: number;

beforeEach(async () => {
  ids = await seedFixture();
  tokens = {
    ADMIN: await tokenFor(request(app), "admin@test.local"),
    ANALYST: await tokenFor(request(app), "analyst@test.local"),
    VIEWER: await tokenFor(request(app), "viewer@test.local"),
  };

  const unscored = await prisma.asset.create({
    data: { organizationId: ids.organizationId, name: "Unscored Asset", type: "API", phiVolume: 10 },
  });
  unscoredAssetId = unscored.id;

  await prisma.identity.createMany({
    data: [
      { organizationId: ids.organizationId, displayName: "Grace Okafor", email: "g.okafor@test.local", kind: "USER", role: "ANALYST" },
      { organizationId: ids.organizationId, displayName: "svc-import-test", kind: "SERVICE_ACCOUNT", role: "ANALYST" },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Attaches `csv` as a multipart upload, the way a browser form would. */
function upload(path: string, csv: string, token: string, filename = "data.csv") {
  return request(app)
    .post(path)
    .set("Authorization", `Bearer ${token}`)
    .attach("file", Buffer.from(csv, "utf8"), { filename, contentType: "text/csv" });
}

const validate = (entity: string, csv: string, token = tokens.ADMIN, filename?: string) =>
  upload(`/api/import/${entity}/validate`, csv, token, filename);

const doImport = (entity: string, csv: string, token = tokens.ADMIN, filename?: string) =>
  upload(`/api/import/${entity}`, csv, token, filename);

const ASSET_HEADER = "name,type,phiVolume,encrypted,mfaEnabled,lastAssessedAt";
const TWO_ASSETS =
  `${ASSET_HEADER}\n` +
  "Imported Portal,OTHER,1200,true,true,2026-08-01\n" +
  "Imported Lab API,API,64200,true,false,\n";

// ---------------------------------------------------------------- templates

describe("GET /api/import/:entity/template", () => {
  const ENTITIES = ["assets", "phi-types", "data-flows", "vendors", "access-grants", "threats", "risks"];

  it.each(ENTITIES)("serves a downloadable template for %s", async (entity) => {
    const res = await request(app)
      .get(`/api/import/${entity}/template`)
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(`drishti-${entity}-template.csv`);
    expect(res.text.trim().split("\r\n")).toHaveLength(2);
  });

  it("round-trips: its own template validates as a correct file", async () => {
    const template = await request(app)
      .get("/api/import/vendors/template")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    const res = await validate("vendors", template.text);
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
  });

  it("404s an unknown entity and lists the supported ones", async () => {
    const res = await request(app)
      .get("/api/import/unicorns/template")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain("assets");
  });
});

// ---------------------------------------------------------------- contract

describe("GET /api/import", () => {
  it("returns the column contract for all seven entities", async () => {
    const res = await request(app)
      .get("/api/import")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { entity: string }) => e.entity)).toEqual([
      "assets", "phi-types", "data-flows", "vendors", "access-grants", "threats", "risks",
    ]);
  });

  it("describes each column well enough for a UI to build a form from it", async () => {
    const res = await request(app)
      .get("/api/import")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    const assets = res.body.data.find((e: { entity: string }) => e.entity === "assets");
    expect(assets).toMatchObject({ model: "Asset", naturalKey: ["name"] });

    const type = assets.columns.find((c: { column: string }) => c.column === "type");
    expect(type).toMatchObject({ type: "enum", required: true });
    expect(type.values).toContain("CLOUD_STORAGE");

    // Reference columns say which model they point at, so a UI can warn
    // before upload rather than after.
    const flows = res.body.data.find((e: { entity: string }) => e.entity === "data-flows");
    const source = flows.columns.find((c: { column: string }) => c.column === "sourceAssetName");
    expect(source.referencesModel).toBe("Asset");
  });

  it("never leaks a score or band column for risks", async () => {
    const res = await request(app)
      .get("/api/import")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);

    const risks = res.body.data.find((e: { entity: string }) => e.entity === "risks");
    const columns = risks.columns.map((c: { column: string }) => c.column);
    expect(columns).not.toContain("score");
    expect(columns).not.toContain("band");
  });

  it.each(["ANALYST", "VIEWER"] as const)("refuses %s with 403", async (role) => {
    const res = await request(app)
      .get("/api/import")
      .set("Authorization", `Bearer ${tokens[role]}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses an anonymous caller with 401", async () => {
    expect((await request(app).get("/api/import")).status).toBe(401);
  });
});

// ---------------------------------------------------------------- happy paths

describe("happy path — every entity imports and is queryable afterward", () => {
  it("assets", async () => {
    const dry = await validate("assets", TWO_ASSETS);
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ valid: true, totalRows: 2, errors: [] });
    expect(dry.body.data.preview).toHaveLength(2);
    // Dry run must not have written.
    expect(await prisma.asset.count({ where: { name: "Imported Portal" } })).toBe(0);

    const res = await doImport("assets", TWO_ASSETS);
    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(2);

    const created = await prisma.asset.findFirst({ where: { name: "Imported Portal" } });
    expect(created).toMatchObject({
      type: "OTHER", phiVolume: 1200, encrypted: true, mfaEnabled: true,
    });
    expect(created?.lastAssessedAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");

    // Optional blank column falls back to the schema default rather than null.
    const second = await prisma.asset.findFirst({ where: { name: "Imported Lab API" } });
    expect(second?.lastAssessedAt).toBeNull();

    // And it is visible through the ordinary read endpoint.
    const list = await request(app).get("/api/assets").set("Authorization", `Bearer ${tokens.ADMIN}`);
    expect(list.body.data.map((a: { name: string }) => a.name)).toContain("Imported Portal");
  });

  it("phi-types", async () => {
    const csv = "name,sensitivity\nGenetic,CRITICAL\nDemographic,LOW\n";
    const res = await doImport("phi-types", csv);
    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(2);
    expect(await prisma.pHIType.findFirst({ where: { name: "Genetic" } })).toMatchObject({
      sensitivity: "CRITICAL",
    });
  });

  it("data-flows, resolving both assets and the PHI type by name", async () => {
    const csv =
      "sourceAssetName,targetAssetName,phiTypeName,recordsPerDay,encrypted\n" +
      "Test Billing,Test EHR,Clinical,4200,false\n";

    const res = await doImport("data-flows", csv);
    expect(res.status).toBe(201);

    const flow = await prisma.dataFlow.findFirst({
      where: { sourceAssetId: ids.billingId, targetAssetId: ids.ehrId },
    });
    expect(flow).toMatchObject({ recordsPerDay: 4200, encrypted: false, phiTypeId: ids.phiTypeId });
  });

  it("vendors", async () => {
    const csv = "name,baaStatus,phiVolume,lastAssessedAt\nNorthwind Claims,MISSING,71300,\n";
    const res = await doImport("vendors", csv);
    expect(res.status).toBe(201);
    expect(await prisma.vendor.findFirst({ where: { name: "Northwind Claims" } })).toMatchObject({
      baaStatus: "MISSING", phiVolume: 71300, lastAssessedAt: null,
    });
  });

  it("access-grants, resolving identity and asset by name", async () => {
    const csv =
      "identityName,assetName,level,grantedAt,lastUsedAt\n" +
      "Grace Okafor,Test EHR,WRITE,2026-02-27,2026-09-14\n";

    const res = await doImport("access-grants", csv);
    expect(res.status).toBe(201);

    const identity = await prisma.identity.findFirst({ where: { organizationId: ids.organizationId, displayName: "Grace Okafor" } });
    const grant = await prisma.accessGrant.findFirst({
      where: { identityId: identity?.id, assetId: ids.ehrId },
    });
    expect(grant?.level).toBe("WRITE");
    expect(grant?.lastUsedAt?.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("threats", async () => {
    const csv =
      "assetName,severity,status,title,description,detectedAt,resolvedAt\n" +
      "Test EHR,CRITICAL,INVESTIGATING,Bulk export detected,847 records left the estate,2026-09-16,\n";

    const res = await doImport("threats", csv);
    expect(res.status).toBe(201);

    const threat = await prisma.threat.findFirst({ where: { title: "Bulk export detected" } });
    expect(threat).toMatchObject({ assetId: ids.ehrId, severity: "CRITICAL", status: "INVESTIGATING" });
    expect(threat?.resolvedAt).toBeNull();
  });

  /**
   * The imported row must be scored by the engine, not by the file. 5/4/5/3
   * is 48.00 HIGH; a file cannot ask for anything else because there is no
   * band column to ask with.
   */
  it("risks, scoring through the engine rather than trusting the file", async () => {
    const csv = "assetName,likelihood,impact,exposure,controlGap\nUnscored Asset,5,4,5,3\n";
    const res = await doImport("risks", csv);
    expect(res.status).toBe(201);

    const risk = await prisma.risk.findFirst({ where: { assetId: unscoredAssetId } });
    expect(risk).toMatchObject({ likelihood: 5, impact: 4, exposure: 5, controlGap: 3, score: 48, band: "HIGH" });
  });

  it("accepts a natural key whose case differs from the stored record", async () => {
    const csv = "assetName,likelihood,impact,exposure,controlGap\nunscored ASSET,2,2,2,2\n";
    const res = await doImport("risks", csv);
    expect(res.status).toBe(201);
    expect(await prisma.risk.count({ where: { assetId: unscoredAssetId } })).toBe(1);
  });
});

// ---------------------------------------------------------------- RBAC

describe("RBAC — ADMIN only, on all three endpoint types", () => {
  const CASES: Array<[string, (t: string) => Promise<request.Response>]> = [
    ["template", (t) => request(app).get("/api/import/assets/template").set("Authorization", `Bearer ${t}`)],
    ["validate", (t) => validate("assets", TWO_ASSETS, t)],
    ["import", (t) => doImport("assets", TWO_ASSETS, t)],
  ];

  for (const [label, call] of CASES) {
    it(`${label} refuses ANALYST with 403`, async () => {
      const res = await call(tokens.ANALYST);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it(`${label} refuses VIEWER with 403`, async () => {
      const res = await call(tokens.VIEWER);
      expect(res.status).toBe(403);
    });

    it(`${label} refuses an anonymous caller with 401, not 403`, async () => {
      const res = await call("not-a-real-token");
      expect(res.status).toBe(401);
    });
  }

  it("a refused import writes nothing", async () => {
    await doImport("assets", TWO_ASSETS, tokens.ANALYST);
    expect(await prisma.asset.count({ where: { name: "Imported Portal" } })).toBe(0);
  });
});

// ---------------------------------------------------------------- rejections

describe("invalid files are rejected and write nothing", () => {
  it("reports a per-row error list and imports none of the file", async () => {
    const csv =
      `${ASSET_HEADER}\n` +
      "Good One,API,10,true,true,\n" +
      "Bad Row,MAINFRAME,10,true,true,\n" +
      "Another Good,API,20,true,true,\n";

    const res = await doImport("assets", csv);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMPORT_VALIDATION_FAILED");
    expect(res.body.error.report.errors).toContainEqual(
      expect.objectContaining({ row: 3, field: "type" }),
    );

    // Atomic: the two valid rows either side of the bad one are absent too.
    expect(await prisma.asset.count({ where: { name: { in: ["Good One", "Another Good"] } } })).toBe(0);
  });

  it("validate reports the same problems with 200 and valid:false", async () => {
    const csv = `${ASSET_HEADER}\nBad Row,MAINFRAME,10,true,true,\n`;
    const res = await validate("assets", csv);
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.errors[0]).toMatchObject({ row: 2, field: "type" });
  });

  it("rejects an empty file", async () => {
    const res = await doImport("assets", "");
    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0].message).toContain("no data rows");
  });

  it("rejects a header-only file", async () => {
    const res = await doImport("assets", `${ASSET_HEADER}\n`);
    expect(res.status).toBe(400);
  });

  it("rejects malformed CSV with the wrong headers", async () => {
    const res = await doImport("assets", "foo,bar\n1,2\n");
    expect(res.status).toBe(400);
    const messages = res.body.error.report.errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toContain("Missing required column");
  });

  it("rejects a request with no file attached", async () => {
    const res = await request(app)
      .post("/api/import/assets")
      .set("Authorization", `Bearer ${tokens.ADMIN}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("No file uploaded");
  });

  it("404s an unknown entity", async () => {
    const res = await doImport("unicorns", TWO_ASSETS);
    expect(res.status).toBe(404);
  });
});

describe("duplicate detection", () => {
  it("rejects a natural key repeated within one file", async () => {
    const csv = `${ASSET_HEADER}\nTwice,API,1,true,true,\nTwice,EHR,2,true,true,\n`;
    const res = await doImport("assets", csv);

    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0].message).toContain("Duplicate");
    expect(await prisma.asset.count({ where: { name: "Twice" } })).toBe(0);
  });

  /**
   * Regression: row numbers used to be recomputed over the surviving rows, so
   * one bad row early in the file shifted every later error up a line. The
   * line number is the only part of the report a user can act on.
   */
  it("reports the true file line for a duplicate that follows a broken row", async () => {
    const csv =
      `${ASSET_HEADER}\n` +
      "Fresh One,API,1,true,true,\n" +          // line 2, fine
      "Broken,MAINFRAME,abc,maybe,true,\n" +    // line 3, unparseable
      "Test EHR,API,5,true,true,\n";            // line 4, duplicate of seeded asset

    const res = await doImport("assets", csv);
    expect(res.status).toBe(400);

    const errors = res.body.error.report.errors as Array<{ row: number; message: string }>;
    const duplicate = errors.find((e) => e.message.includes("already exists"));
    expect(duplicate?.row).toBe(4);
    expect(errors.filter((e) => e.message.includes("must be")).every((e) => e.row === 3)).toBe(true);
  });

  it("rejects an asset that already exists in the database", async () => {
    const csv = `${ASSET_HEADER}\nTest EHR,API,1,true,true,\n`;
    const res = await doImport("assets", csv);

    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0].message).toContain("already exists");
    // The existing row is untouched, not overwritten.
    expect(await prisma.asset.findFirst({ where: { name: "Test EHR" } })).toMatchObject({ type: "EHR" });
  });

  it("matches an existing record case-insensitively", async () => {
    const res = await doImport("assets", `${ASSET_HEADER}\ntest ehr,API,1,true,true,\n`);
    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0].message).toContain("already exists");
  });

  it("rejects a data flow that already exists (composite key)", async () => {
    const csv =
      "sourceAssetName,targetAssetName,phiTypeName,recordsPerDay,encrypted\n" +
      "Test EHR,Test Billing,Clinical,999,true\n";
    const res = await doImport("data-flows", csv);
    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0].message).toContain("already exists");
  });

  it("rejects a second risk for an asset that already has one", async () => {
    const csv = "assetName,likelihood,impact,exposure,controlGap\nTest EHR,1,1,1,1\n";
    const res = await doImport("risks", csv);
    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0].message).toContain("already exists");
  });

  it("rejects a duplicate access grant for the same identity and asset", async () => {
    const csv = "identityName,assetName,level,grantedAt,lastUsedAt\nGrace Okafor,Test EHR,READ,,\n";
    expect((await doImport("access-grants", csv)).status).toBe(201);

    const again = await doImport("access-grants", csv);
    expect(again.status).toBe(400);
    expect(again.body.error.report.errors[0].message).toContain("already exists");
  });
});

describe("foreign keys by natural key", () => {
  it("fails clearly when a referenced asset does not exist", async () => {
    const csv = "assetName,likelihood,impact,exposure,controlGap\nNo Such Asset,3,3,3,3\n";
    const res = await doImport("risks", csv);

    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0]).toMatchObject({ row: 2, field: "assetName" });
    expect(res.body.error.report.errors[0].message).toContain("No Asset found");
  });

  it("fails clearly when a referenced PHI type does not exist", async () => {
    const csv =
      "sourceAssetName,targetAssetName,phiTypeName,recordsPerDay,encrypted\n" +
      "Test EHR,Test Billing,Nonexistent,10,true\n";
    const res = await doImport("data-flows", csv);
    expect(res.body.error.report.errors[0].message).toContain("No PHIType found");
  });

  it("cannot have an ambiguous identity to resolve in the first place", async () => {
    // Identity used to allow duplicate display names, so the import layer had
    // to detect ambiguity and refuse to guess. The platform migration added a
    // unique constraint on (organizationId, displayName), which makes the
    // ambiguous case unrepresentable -- the second insert is rejected by the
    // database rather than discovered later by the importer.
    //
    // The importer's ambiguity branch is retained as defence in depth; this
    // test now pins the stronger guarantee that replaced it.
    await expect(
      prisma.identity.create({
        data: {
          organizationId: ids.organizationId,
          displayName: "Grace Okafor",
          email: "second.grace@test.local",
          kind: "USER",
        },
      }),
    ).rejects.toThrow(/Unique constraint/i);

    // And the name still resolves, to the one identity that holds it.
    const csv = "identityName,assetName,level,grantedAt,lastUsedAt\nGrace Okafor,Test EHR,READ,,\n";
    const res = await doImport("access-grants", csv);
    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(1);
  });

  it("validate surfaces the same reference failure without writing", async () => {
    const csv = "assetName,likelihood,impact,exposure,controlGap\nNo Such Asset,3,3,3,3\n";
    const res = await validate("risks", csv);
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
  });
});

describe("file handling safety", () => {
  it("rejects a file that is not named .csv", async () => {
    const res = await doImport("assets", TWO_ASSETS, tokens.ADMIN, "payload.txt");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Only .csv files");
  });

  it("rejects an executable-looking upload", async () => {
    const res = await doImport("assets", TWO_ASSETS, tokens.ADMIN, "evil.csv.exe");
    expect(res.status).toBe(400);
  });

  it("rejects a file over the 2MB limit with 413", async () => {
    // Padded so the payload is unambiguously over 2MB; a file just under the
    // limit would import successfully and prove nothing.
    const pad = "x".repeat(48);
    const rows = Array.from({ length: 40_000 }, (_, i) => `Asset ${i} ${pad},API,1,true,true,`).join("\n");
    const csv = `${ASSET_HEADER}\n${rows}\n`;
    expect(Buffer.byteLength(csv, "utf8")).toBeGreaterThan(2 * 1024 * 1024);

    const res = await doImport("assets", csv);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    expect(await prisma.asset.count({ where: { name: "Asset 0" } })).toBe(0);
  });

  it("treats a formula cell as a problem, not as something to run", async () => {
    const csv = `${ASSET_HEADER}\n=cmd|'/c calc'!A1,API,1,true,true,\n`;
    const res = await doImport("assets", csv);

    expect(res.status).toBe(400);
    expect(res.body.error.report.errors[0].message).toContain("formula");
    expect(await prisma.asset.count({ where: { name: { contains: "cmd" } } })).toBe(0);
  });

  it("stores a value containing SQL syntax as inert text", async () => {
    const name = "Robert'); DROP TABLE \"Asset\";--";
    const csv = `${ASSET_HEADER}\n"${name.replace(/"/g, '""')}",API,1,true,true,\n`;

    const res = await doImport("assets", csv);
    expect(res.status).toBe(201);

    // The table is still there and the value round-tripped verbatim.
    expect(await prisma.asset.findFirst({ where: { name } })).not.toBeNull();
    expect(await prisma.asset.count()).toBeGreaterThan(0);
  });
});
