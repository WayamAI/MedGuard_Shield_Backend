/**
 * CSV import contracts, one per importable entity.
 *
 * Pure data and pure functions only — no Prisma import — so the column rules
 * can be unit-tested without a database, the same split riskScoring.ts has
 * from riskEngine.ts.
 *
 * Every column maps to a real field on the Prisma model. Foreign keys are
 * never exposed as database ids: the person filling in the file knows an asset
 * as "Epic EHR Core", not as row 3. Each `ref` column therefore carries a
 * natural key that importService.ts resolves server-side.
 */

export const ASSET_TYPES = ["EHR", "DATABASE", "API", "CLOUD_STORAGE", "ANALYTICS", "OTHER"] as const;
export const SENSITIVITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const BAA_STATUSES = ["SIGNED", "PENDING", "EXPIRED", "MISSING"] as const;
export const ACCESS_LEVELS = ["READ", "WRITE", "ADMIN"] as const;
export const THREAT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const THREAT_STATUSES = ["OPEN", "INVESTIGATING", "RESOLVED", "FALSE_POSITIVE"] as const;

/** What a cell is coerced to before it ever reaches Prisma. */
export type ColumnType = "string" | "int" | "boolean" | "date" | "enum";

/** The three models an imported row can point at by natural key. */
export type RefTarget = "Asset" | "PHIType" | "Identity";

export type ColumnSpec = {
  /** Header text in the CSV. */
  column: string;
  type: ColumnType;
  required: boolean;
  /** Allowed values when type is "enum". */
  values?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
  /**
   * Set when this column is a foreign key expressed as a natural key. The
   * resolved id lands on `foreignKeyField` of the created row.
   */
  ref?: { target: RefTarget; naturalKeyField: string; foreignKeyField: string };
  /** Field on the Prisma model, for non-ref columns. */
  field?: string;
  description: string;
  /** Sample value used by the template endpoint. */
  example: string;
};

export type EntitySpec = {
  /** URL segment: /api/import/<slug> */
  slug: string;
  label: string;
  model: string;
  columns: ColumnSpec[];
  /**
   * Columns whose combined values identify a row uniquely. Used both for
   * in-file duplicate detection and for the pre-existing-record check.
   */
  naturalKey: string[];
  /** Plain-English description of the natural key, echoed in errors and docs. */
  naturalKeyLabel: string;
};

const ASSETS: EntitySpec = {
  slug: "assets",
  label: "Assets",
  model: "Asset",
  naturalKey: ["name"],
  naturalKeyLabel: "name",
  columns: [
    { column: "name", field: "name", type: "string", required: true, maxLength: 120,
      description: "Unique system name.", example: "Epic EHR Core" },
    { column: "type", field: "type", type: "enum", required: true, values: ASSET_TYPES,
      description: "Asset category.", example: "EHR" },
    { column: "phiVolume", field: "phiVolume", type: "int", required: false, min: 0,
      description: "PHI records held. Defaults to 0.", example: "412000" },
    { column: "encrypted", field: "encrypted", type: "boolean", required: false,
      description: "At-rest encryption. Defaults to false.", example: "true" },
    { column: "mfaEnabled", field: "mfaEnabled", type: "boolean", required: false,
      description: "MFA required for access. Defaults to false.", example: "true" },
    { column: "lastAssessedAt", field: "lastAssessedAt", type: "date", required: false,
      description: "Date of last assessment (YYYY-MM-DD). Blank means never.", example: "2026-08-14" },
  ],
};

const PHI_TYPES: EntitySpec = {
  slug: "phi-types",
  label: "PHI Types",
  model: "PHIType",
  naturalKey: ["name"],
  naturalKeyLabel: "name",
  columns: [
    { column: "name", field: "name", type: "string", required: true, maxLength: 120,
      description: "Unique PHI category name.", example: "Clinical" },
    { column: "sensitivity", field: "sensitivity", type: "enum", required: true, values: SENSITIVITIES,
      description: "Sensitivity tier.", example: "HIGH" },
  ],
};

const DATA_FLOWS: EntitySpec = {
  slug: "data-flows",
  label: "Data Flows",
  model: "DataFlow",
  naturalKey: ["sourceAssetName", "targetAssetName", "phiTypeName"],
  naturalKeyLabel: "source asset + target asset + PHI type",
  columns: [
    { column: "sourceAssetName", type: "string", required: true,
      ref: { target: "Asset", naturalKeyField: "name", foreignKeyField: "sourceAssetId" },
      description: "Name of the asset the records leave. Must already exist.", example: "Epic EHR Core" },
    { column: "targetAssetName", type: "string", required: true,
      ref: { target: "Asset", naturalKeyField: "name", foreignKeyField: "targetAssetId" },
      description: "Name of the asset the records arrive at. Must already exist.", example: "Billing Engine DB" },
    { column: "phiTypeName", type: "string", required: true,
      ref: { target: "PHIType", naturalKeyField: "name", foreignKeyField: "phiTypeId" },
      description: "Name of the PHI category moving. Must already exist.", example: "Financial" },
    { column: "recordsPerDay", field: "recordsPerDay", type: "int", required: true, min: 0,
      description: "Records moved per day.", example: "87100" },
    { column: "encrypted", field: "encrypted", type: "boolean", required: false,
      description: "Encrypted in transit. Defaults to true.", example: "false" },
  ],
};

const VENDORS: EntitySpec = {
  slug: "vendors",
  label: "Vendors",
  model: "Vendor",
  naturalKey: ["name"],
  naturalKeyLabel: "name",
  columns: [
    { column: "name", field: "name", type: "string", required: true, maxLength: 120,
      description: "Unique vendor name.", example: "Northwind Claims Processing" },
    { column: "baaStatus", field: "baaStatus", type: "enum", required: false, values: BAA_STATUSES,
      description: "Business Associate Agreement state. Defaults to MISSING.", example: "SIGNED" },
    { column: "phiVolume", field: "phiVolume", type: "int", required: false, min: 0,
      description: "PHI records the vendor can reach. Defaults to 0.", example: "71300" },
    { column: "lastAssessedAt", field: "lastAssessedAt", type: "date", required: false,
      description: "Date of last vendor assessment (YYYY-MM-DD).", example: "2026-06-12" },
  ],
};

const ACCESS_GRANTS: EntitySpec = {
  slug: "access-grants",
  label: "Access Grants",
  model: "AccessGrant",
  naturalKey: ["identityName", "assetName"],
  naturalKeyLabel: "identity display name + asset name",
  columns: [
    { column: "identityName", type: "string", required: true,
      ref: { target: "Identity", naturalKeyField: "displayName", foreignKeyField: "identityId" },
      description: "Identity displayName. Must already exist and be unambiguous.", example: "Maria Santos" },
    { column: "assetName", type: "string", required: true,
      ref: { target: "Asset", naturalKeyField: "name", foreignKeyField: "assetId" },
      description: "Name of the asset reached. Must already exist.", example: "Epic EHR Core" },
    { column: "level", field: "level", type: "enum", required: false, values: ACCESS_LEVELS,
      description: "Access level. Defaults to READ.", example: "WRITE" },
    { column: "grantedAt", field: "grantedAt", type: "date", required: false,
      description: "When access was granted (YYYY-MM-DD). Defaults to today.", example: "2026-02-27" },
    { column: "lastUsedAt", field: "lastUsedAt", type: "date", required: false,
      description: "When access was last exercised. Blank means never used.", example: "2026-09-14" },
  ],
};

const THREATS: EntitySpec = {
  slug: "threats",
  label: "Threats",
  model: "Threat",
  naturalKey: ["assetName", "title"],
  naturalKeyLabel: "asset name + title",
  columns: [
    { column: "assetName", type: "string", required: true,
      ref: { target: "Asset", naturalKeyField: "name", foreignKeyField: "assetId" },
      description: "Name of the affected asset. Must already exist.", example: "Billing Engine DB" },
    { column: "severity", field: "severity", type: "enum", required: true, values: THREAT_SEVERITIES,
      description: "Threat severity.", example: "CRITICAL" },
    { column: "status", field: "status", type: "enum", required: false, values: THREAT_STATUSES,
      description: "Triage state. Defaults to OPEN.", example: "INVESTIGATING" },
    { column: "title", field: "title", type: "string", required: true, maxLength: 200,
      description: "Short headline.", example: "Bulk PHI export from billing database" },
    { column: "description", field: "description", type: "string", required: true, maxLength: 2000,
      description: "What was detected.", example: "847 patient records exported to an unmanaged endpoint." },
    { column: "detectedAt", field: "detectedAt", type: "date", required: false,
      description: "When detected (YYYY-MM-DD). Defaults to today.", example: "2026-09-16" },
    { column: "resolvedAt", field: "resolvedAt", type: "date", required: false,
      description: "When resolved. Blank while still open.", example: "" },
  ],
};

/**
 * Risk deliberately has no score or band column. Both are derived by the
 * scoring engine from the four 1-5 judgements; accepting them from a file
 * would let a spreadsheet overrule the engine.
 */
const RISKS: EntitySpec = {
  slug: "risks",
  label: "Risks",
  model: "Risk",
  naturalKey: ["assetName"],
  naturalKeyLabel: "asset name",
  columns: [
    { column: "assetName", type: "string", required: true,
      ref: { target: "Asset", naturalKeyField: "name", foreignKeyField: "assetId" },
      description: "Name of the assessed asset. Must already exist.", example: "Epic EHR Core" },
    { column: "likelihood", field: "likelihood", type: "int", required: true, min: 1, max: 5,
      description: "Assessor judgement, 1-5.", example: "5" },
    { column: "impact", field: "impact", type: "int", required: true, min: 1, max: 5,
      description: "Assessor judgement, 1-5.", example: "4" },
    { column: "exposure", field: "exposure", type: "int", required: true, min: 1, max: 5,
      description: "Assessor judgement, 1-5.", example: "5" },
    { column: "controlGap", field: "controlGap", type: "int", required: true, min: 1, max: 5,
      description: "Assessor judgement, 1-5.", example: "3" },
  ],
};

export const ENTITY_SPECS: readonly EntitySpec[] = [
  ASSETS, PHI_TYPES, DATA_FLOWS, VENDORS, ACCESS_GRANTS, THREATS, RISKS,
];

export const ENTITY_SLUGS: readonly string[] = ENTITY_SPECS.map((e) => e.slug);

export function specFor(slug: string): EntitySpec | null {
  return ENTITY_SPECS.find((e) => e.slug === slug) ?? null;
}
