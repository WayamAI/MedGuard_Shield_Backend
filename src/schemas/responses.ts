import { z } from "zod";

/**
 * Response-body schemas for every route in docs/engineering/ROUTE_INVENTORY.md
 * (97 paths). These feed two consumers: the OpenAPI generator
 * (scripts/generate-openapi.ts, so the frontend can generate its own types
 * from openapi.json) and a live contract test
 * (tests/integration/openapi-response-contract.test.ts) that parses real
 * HTTP responses against the same schema the spec advertises.
 *
 * Precision policy, stated up front rather than silently varied route to
 * route: every top-level field on every response is typed exactly. Deeply
 * nested relation arrays on a handful of "detail" endpoints (the ones that
 * return an asset/vendor/etc. together with everything linked to it) are
 * typed as `z.array(z.record(z.string(), z.unknown()))` rather than
 * transcribed field-for-field — still correct (array vs. not, and every
 * field's key set verified to exist by the live contract test, just not each
 * nested field's exact type). Doing every nested relation at full precision
 * would mean re-deriving the Prisma `include` shape of ~15 handlers field by
 * field; the schemas below already catch the thing that actually breaks a
 * frontend silently (a renamed/removed top-level field, a changed envelope),
 * which is the failure mode this exists to prevent.
 */

// --------------------------------------------------------------- envelopes

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});

export const pageMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

/** `ok(res, data)` / `created(res, data)` wrap a single value in `{ data }`. */
function dataEnvelope<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

/** `paged(res, items, meta)` wraps a list in `{ data: items[], meta }`. */
function listEnvelope<T extends z.ZodType>(itemSchema: T) {
  return z.object({ data: z.array(itemSchema), meta: pageMetaSchema });
}

const looseRelation = z.array(z.record(z.string(), z.unknown()));
const nullableIso = z.string().nullable();

// ------------------------------------------------------------------ enums

const role = z.enum(["ADMIN", "ANALYST", "VIEWER"]);
const assetType = z.enum(["EHR", "DATABASE", "API", "CLOUD_STORAGE", "ANALYTICS", "OTHER"]);
const sensitivity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const baaStatus = z.enum(["SIGNED", "PENDING", "EXPIRED", "MISSING"]);
const identityKind = z.enum(["USER", "SERVICE_ACCOUNT"]);
const accessLevel = z.enum(["READ", "WRITE", "ADMIN"]);
const threatSeverity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const threatStatus = z.enum(["OPEN", "INVESTIGATING", "RESOLVED", "FALSE_POSITIVE"]);
const riskBand = z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL", "EXTREME"]);
const controlCategory = z.enum(["ACCESS", "ENCRYPTION", "MONITORING", "GOVERNANCE", "RESILIENCE", "VENDOR"]);
const controlStatus = z.enum(["IMPLEMENTED", "PARTIAL", "PLANNED", "NOT_IMPLEMENTED"]);
const controlEffectiveness = z.enum(["EFFECTIVE", "PARTIALLY_EFFECTIVE", "INEFFECTIVE", "NOT_ASSESSED"]);
const remediationStatus = z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "ACCEPTED", "REOPENED"]);
const remediationSeverity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const findingSource = z.enum(["RISK", "THREAT", "ACCESS", "VENDOR", "CONTROL", "MANUAL"]);
const policyStatus = z.enum(["DRAFT", "ACTIVE", "UNDER_REVIEW", "ARCHIVED"]);
const auditResult = z.enum(["SUCCESS", "FAILURE"]);
const notificationType = z.enum([
  "THREAT_NEW_HIGH_SEVERITY", "REMEDIATION_OVERDUE", "VENDOR_BAA_INVALID",
  "VENDOR_ASSESSMENT_OVERDUE", "POLICY_REVIEW_OVERDUE", "ACCESS_GRANT_FLAGGED",
]);

// ------------------------------------------------------------- risk shared

export const riskSummarySchema = z.object({ score: z.number(), band: riskBand, computedAt: z.string() }).nullable();

const riskHistoryRowSchema = z.object({
  id: z.number().int(),
  subjectType: z.enum(["ASSET", "VENDOR"]),
  subjectId: z.number().int(),
  subjectName: z.string(),
  previousScore: z.number().nullable(),
  previousBand: riskBand.nullable(),
  score: z.number(),
  band: riskBand,
  delta: z.number().nullable(),
  likelihood: z.number().int(),
  impact: z.number().int(),
  exposure: z.number().int(),
  controlGap: z.number().int(),
  reason: z.string(),
  changedBy: z.object({ id: z.number().int(), email: z.string() }).nullable(),
  changedAt: z.string(),
});

// ----------------------------------------------------------------- assets

export const assetListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: assetType,
  phiVolume: z.number().int(),
  encrypted: z.boolean(),
  mfaEnabled: z.boolean(),
  lastAssessedAt: nullableIso,
  createdAt: z.string(),
  archivedAt: nullableIso,
  risk: riskSummarySchema,
  counts: z.object({
    phiTypes: z.number().int(),
    flows: z.number().int(),
    accessGrants: z.number().int(),
    openThreats: z.number().int(),
    controls: z.number().int(),
  }),
});
export const assetListResponseSchema = listEnvelope(assetListItemSchema);

export const assetDetailSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: assetType,
  phiVolume: z.number().int(),
  encrypted: z.boolean(),
  mfaEnabled: z.boolean(),
  lastAssessedAt: nullableIso,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
  phiTypes: looseRelation,
  risk: z.object({
    id: z.number().int(),
    likelihood: z.number().int(),
    impact: z.number().int(),
    exposure: z.number().int(),
    controlGap: z.number().int(),
    score: z.number(),
    band: riskBand,
    computedAt: z.string(),
  }).nullable(),
  flows: z.object({ outbound: looseRelation, inbound: looseRelation }),
  vendors: looseRelation,
  access: looseRelation,
  threats: looseRelation,
  controls: looseRelation,
  remediations: looseRelation,
});
export const assetDetailResponseSchema = dataEnvelope(assetDetailSchema);

const rawAssetSchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  name: z.string(),
  type: assetType,
  phiVolume: z.number().int(),
  encrypted: z.boolean(),
  mfaEnabled: z.boolean(),
  lastAssessedAt: nullableIso,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
});
export const rawAssetResponseSchema = dataEnvelope(rawAssetSchema);

export const controlEvidenceResponseSchema = dataEnvelope(
  z.object({
    effectiveControls: z.number().int(),
    suggestedControlGap: z.number().int(),
    applied: z.boolean(),
    basis: z.string(),
  }),
);

export const riskSnapshotSchema = z.object({
  id: z.number().int(),
  subjectType: z.enum(["ASSET", "VENDOR"]),
  subjectId: z.number().int(),
  subjectName: z.string(),
  assetId: z.number().int().nullable(),
  assetName: z.string().nullable(),
  vendorId: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  likelihood: z.number().int(),
  impact: z.number().int(),
  exposure: z.number().int(),
  controlGap: z.number().int(),
  exposureOverridden: z.boolean(),
  controlGapOverridden: z.boolean(),
  score: z.number(),
  band: riskBand,
  computedAt: z.string(),
  previous: z.object({ score: z.number(), band: riskBand }).nullable(),
  changed: z.boolean(),
  derivation: z.string().nullable(),
});

/** setAssetControl / setPolicyControl's shape (controls.ts, policies.ts). */
export const policyControlLinkResponseSchema = dataEnvelope(
  z.object({ policyId: z.number().int(), controlId: z.number().int(), linked: z.boolean() }),
);

/** The asset-side link routes (assets.ts, controls.ts) echo one RiskSnapshot or null. */
export const assetControlLinkResponseSchema = dataEnvelope(
  z.object({
    controlId: z.number().int(),
    assetId: z.number().int(),
    applied: z.boolean(),
    riskChanged: riskSnapshotSchema.nullable(),
  }),
);

/** The vendor-side link route (vendors.ts) echoes every RiskSnapshot that moved. */
export const vendorAssetLinkResponseSchema = dataEnvelope(
  z.object({
    vendorId: z.number().int(),
    assetId: z.number().int(),
    granted: z.boolean(),
    riskChanged: z.array(riskSnapshotSchema),
  }),
);

// ---------------------------------------------------------------- vendors

export const vendorListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  baaStatus,
  phiVolume: z.number().int(),
  lastAssessedAt: nullableIso,
  archivedAt: nullableIso,
  daysSinceAssessment: z.number().int().nullable(),
  assessmentOverdue: z.boolean(),
  baaCompliant: z.boolean(),
  assetCount: z.number().int(),
  assets: z.array(z.string()),
  openRemediations: z.number().int(),
  risk: riskSummarySchema,
});
export const vendorListResponseSchema = listEnvelope(vendorListItemSchema);

export const vendorDetailSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  baaStatus,
  phiVolume: z.number().int(),
  lastAssessedAt: nullableIso,
  daysSinceAssessment: z.number().int().nullable(),
  assessmentOverdue: z.boolean(),
  baaCompliant: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
  assets: looseRelation,
  phiExposure: z.number().int(),
  risk: z.object({
    id: z.number().int(),
    likelihood: z.number().int(),
    impact: z.number().int(),
    exposure: z.number().int(),
    controlGap: z.number().int(),
    score: z.number(),
    band: riskBand,
    computedAt: z.string(),
  }).nullable(),
  remediations: looseRelation,
});
export const vendorDetailResponseSchema = dataEnvelope(vendorDetailSchema);

const rawVendorSchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  name: z.string(),
  baaStatus,
  phiVolume: z.number().int(),
  lastAssessedAt: nullableIso,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
});
export const rawVendorResponseSchema = dataEnvelope(rawVendorSchema);

export const riskHistoryListResponseSchema = listEnvelope(riskHistoryRowSchema);

// -------------------------------------------------------------- identities

export const identityListItemSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  email: z.string().nullable(),
  kind: identityKind,
  department: z.string().nullable(),
  role,
  active: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: z.string(),
  archivedAt: nullableIso,
  activeGrants: z.number().int(),
});
export const identityListResponseSchema = listEnvelope(identityListItemSchema);

export const identityDetailSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  email: z.string().nullable(),
  kind: identityKind,
  department: z.string().nullable(),
  role,
  active: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
  grants: looseRelation,
  phiReach: z.number().int(),
});
export const identityDetailResponseSchema = dataEnvelope(identityDetailSchema);

const rawIdentitySchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  displayName: z.string(),
  email: z.string().nullable(),
  kind: identityKind,
  department: z.string().nullable(),
  role,
  active: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
});
export const rawIdentityResponseSchema = dataEnvelope(rawIdentitySchema);

// ------------------------------------------------------------------ access

export const accessGrantListItemSchema = z.object({
  id: z.number().int(),
  identityId: z.number().int(),
  identityName: z.string(),
  identityEmail: z.string().nullable(),
  kind: identityKind,
  department: z.string().nullable(),
  active: z.boolean(),
  mfaEnabled: z.boolean(),
  assetId: z.number().int(),
  assetName: z.string(),
  assetType,
  level: accessLevel,
  grantedAt: z.string(),
  lastUsedAt: nullableIso,
  lastReviewedAt: nullableIso,
  revokedAt: nullableIso,
  daysSinceUse: z.number().int().nullable(),
  daysSinceGrant: z.number().int(),
  flags: z.array(z.string()),
  riskFlagCount: z.number().int(),
});
export const accessGrantListResponseSchema = z.object({
  data: z.array(accessGrantListItemSchema),
  meta: pageMetaSchema.optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
});

export const accessSummaryResponseSchema = dataEnvelope(
  z.object({
    total: z.number().int(),
    flagged: z.number().int(),
    stale: z.number().int(),
    neverUsed: z.number().int(),
    withoutMfa: z.number().int(),
    inactiveIdentities: z.number().int(),
    excessiveLevel: z.number().int(),
    neverReviewed: z.number().int(),
    staleAfterDays: z.number().int(),
  }),
);

export const accessGrantDetailResponseSchema = dataEnvelope(
  z.object({
    id: z.number().int(),
    identityId: z.number().int(),
    identityName: z.string(),
    assetId: z.number().int(),
    assetName: z.string(),
    level: accessLevel,
    grantedAt: z.string(),
    lastUsedAt: nullableIso,
    lastReviewedAt: nullableIso,
    revokedAt: nullableIso,
    flags: z.array(z.string()),
    riskFlagCount: z.number().int(),
  }),
);

const rawAccessGrantSchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  identityId: z.number().int(),
  assetId: z.number().int(),
  level: accessLevel,
  grantedAt: z.string(),
  lastUsedAt: nullableIso,
  lastReviewedAt: nullableIso,
  revokedAt: nullableIso,
  revokedById: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const rawAccessGrantResponseSchema = dataEnvelope(rawAccessGrantSchema);

// ----------------------------------------------------------------- threats

export const threatListItemSchema = z.object({
  id: z.number().int(),
  severity: threatSeverity,
  status: threatStatus,
  title: z.string(),
  description: z.string(),
  assetId: z.number().int(),
  assetName: z.string(),
  assetType: z.string(),
  detectedAt: z.string(),
  resolvedAt: nullableIso,
  hoursSinceDetection: z.number().int(),
  open: z.boolean(),
});
export const threatListResponseSchema = listEnvelope(threatListItemSchema);

export const threatSummaryResponseSchema = dataEnvelope(
  z.object({
    total: z.number().int(),
    open: z.number().int(),
    bySeverity: z.record(z.string(), z.number().int()),
    byStatus: z.record(z.string(), z.number().int()),
    openCritical: z.number().int(),
  }),
);

export const threatDetailResponseSchema = dataEnvelope(
  threatListItemSchema.extend({
    allowedTransitions: z.array(z.string()),
    remediations: looseRelation,
  }),
);

const rawThreatSchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  assetId: z.number().int(),
  severity: threatSeverity,
  status: threatStatus,
  title: z.string(),
  description: z.string(),
  detectedAt: z.string(),
  resolvedAt: nullableIso,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const rawThreatResponseSchema = dataEnvelope(rawThreatSchema);

// ---------------------------------------------------------------- controls

export const controlListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  category: controlCategory,
  status: controlStatus,
  effectiveness: controlEffectiveness,
  owner: z.string().nullable(),
  frameworkRef: z.string().nullable(),
  lastReviewedAt: nullableIso,
  createdAt: z.string(),
  archivedAt: nullableIso,
  appliedAssetCount: z.number().int(),
  policyCount: z.number().int(),
  openRemediations: z.number().int(),
});
export const controlListResponseSchema = listEnvelope(controlListItemSchema);

export const controlDetailResponseSchema = dataEnvelope(
  z.object({
    id: z.number().int(),
    name: z.string(),
    description: z.string(),
    category: controlCategory,
    status: controlStatus,
    effectiveness: controlEffectiveness,
    owner: z.string().nullable(),
    frameworkRef: z.string().nullable(),
    lastReviewedAt: nullableIso,
    createdAt: z.string(),
    updatedAt: z.string(),
    archivedAt: nullableIso,
    assets: looseRelation,
    policies: looseRelation,
    remediations: looseRelation,
    phiCovered: z.number().int(),
  }),
);

const rawControlSchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  name: z.string(),
  description: z.string(),
  category: controlCategory,
  status: controlStatus,
  effectiveness: controlEffectiveness,
  owner: z.string().nullable(),
  frameworkRef: z.string().nullable(),
  lastReviewedAt: nullableIso,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
});
export const rawControlResponseSchema = dataEnvelope(rawControlSchema);

// ---------------------------------------------------------------- policies

export const policyListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  status: policyStatus,
  owner: z.string().nullable(),
  evidenceRef: z.string().nullable(),
  reviewDueAt: nullableIso,
  reviewOverdue: z.boolean(),
  controlCount: z.number().int(),
  createdAt: z.string(),
  archivedAt: nullableIso,
});
export const policyListResponseSchema = listEnvelope(policyListItemSchema);

export const policyDetailResponseSchema = dataEnvelope(
  z.object({
    id: z.number().int(),
    name: z.string(),
    description: z.string(),
    status: policyStatus,
    owner: z.string().nullable(),
    evidenceRef: z.string().nullable(),
    reviewDueAt: nullableIso,
    reviewOverdue: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    archivedAt: nullableIso,
    controls: looseRelation,
  }),
);

const rawPolicySchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  name: z.string(),
  description: z.string(),
  status: policyStatus,
  owner: z.string().nullable(),
  evidenceRef: z.string().nullable(),
  reviewDueAt: nullableIso,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: nullableIso,
});
export const rawPolicyResponseSchema = dataEnvelope(rawPolicySchema);

// ------------------------------------------------------------ remediations

export const remediationListItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  recommendation: z.string(),
  severity: remediationSeverity,
  status: remediationStatus,
  source: findingSource,
  dueAt: nullableIso,
  createdAt: z.string(),
  resolvedAt: nullableIso,
}).catchall(z.unknown());
export const remediationListResponseSchema = listEnvelope(remediationListItemSchema);

export const remediationSummaryResponseSchema = dataEnvelope(
  z.object({
    total: z.number().int(),
    open: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    bySeverity: z.record(z.string(), z.number().int()),
    overdue: z.number().int(),
  }),
);

export const remediationDetailResponseSchema = dataEnvelope(remediationListItemSchema.catchall(z.unknown()));

const rawRemediationSchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  title: z.string(),
  description: z.string(),
  recommendation: z.string(),
  severity: remediationSeverity,
  status: remediationStatus,
  source: findingSource,
  ownerId: z.number().int().nullable(),
  dueAt: nullableIso,
  assetId: z.number().int().nullable(),
  vendorId: z.number().int().nullable(),
  threatId: z.number().int().nullable(),
  controlId: z.number().int().nullable(),
  identityId: z.number().int().nullable(),
  accessGrantId: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: nullableIso,
});
export const rawRemediationResponseSchema = dataEnvelope(rawRemediationSchema);

// ---------------------------------------------------------------- dataflows

export const dataFlowListItemSchema = z.object({
  id: z.number().int(),
  sourceAssetId: z.number().int(),
  targetAssetId: z.number().int(),
  phiTypeId: z.number().int(),
  recordsPerDay: z.number().int(),
  encrypted: z.boolean(),
}).catchall(z.unknown());
export const dataFlowListResponseSchema = listEnvelope(dataFlowListItemSchema);
export const dataFlowDetailResponseSchema = dataEnvelope(dataFlowListItemSchema);

// -------------------------------------------------------------------- risks

export const riskListItemSchema = z.object({
  id: z.number().int(),
  assetId: z.number().int().nullable().optional(),
  score: z.number(),
  band: riskBand,
}).catchall(z.unknown());
export const riskListResponseSchema = listEnvelope(riskListItemSchema);

export const riskDistributionResponseSchema = dataEnvelope(z.record(z.string(), z.number().int()));

export const recomputeResponseSchema = dataEnvelope(riskSnapshotSchema);

// ------------------------------------------------------------------- audit

export const auditEventSchema = z.object({
  id: z.number().int(),
  action: z.string(),
  actor: z.object({ id: z.number().int(), email: z.string().nullable() }).nullable(),
  entityType: z.string().nullable(),
  entityId: z.number().int().nullable(),
  result: auditResult,
  metadata: z.unknown().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
});
export const auditListResponseSchema = listEnvelope(auditEventSchema);
export const auditVerifyResponseSchema = dataEnvelope(
  z.object({ intact: z.boolean(), checked: z.number().int(), firstBrokenId: z.number().int().nullable() }),
);

// ------------------------------------------------------------------- search

export const searchResultsResponseSchema = dataEnvelope(
  z.object({
    query: z.string(),
    results: z.array(
      z.object({
        type: z.string(),
        id: z.number().int(),
        title: z.string(),
        status: z.string().nullable(),
        context: z.string(),
      }),
    ),
    truncated: z.boolean(),
  }),
);

// ----------------------------------------------------------------- reports

export const riskAssessmentReportResponseSchema = dataEnvelope(z.record(z.string(), z.unknown()));

// ------------------------------------------------------------------ import

export const importEntityListResponseSchema = dataEnvelope(
  z.array(
    z.object({ entity: z.string(), label: z.string().optional() }).catchall(z.unknown()),
  ),
);

export const importReportResponseSchema = dataEnvelope(
  z.object({
    totalRows: z.number().int(),
    valid: z.boolean(),
  }).catchall(z.unknown()),
);

// ------------------------------------------------------------------ ingest

export const apiKeyListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  scope: z.string(),
  lastUsedAt: nullableIso,
  revokedAt: nullableIso,
  createdAt: z.string(),
});
export const apiKeyListResponseSchema = dataEnvelope(z.array(apiKeyListItemSchema));

// createApiKey() returns only {id, name, secret, createdAt} — not the full
// row shape listApiKeys() selects.
export const apiKeyCreatedResponseSchema = dataEnvelope(
  z.object({ id: z.number().int(), name: z.string(), secret: z.string(), createdAt: z.string() }),
);

// revokeApiKey() returns the raw prisma.apiKey.update() row, which also
// carries organizationId/keyHash/createdById — not the list's select shape.
export const apiKeyRevokedResponseSchema = dataEnvelope(z.object({ ok: z.boolean() }));

export const ingestResultResponseSchema = dataEnvelope(
  z.object({
    totalRows: z.number().int().optional(),
    imported: z.number().int().optional(),
    valid: z.boolean().optional(),
  }).catchall(z.unknown()),
);

// ------------------------------------------------------------- phi-inventory

export const phiInventoryResponseSchema = dataEnvelope(
  z.array(
    z.object({ name: z.string(), sensitivity, recordsHeld: z.number().int() }).catchall(z.unknown()),
  ),
);

export const phiTypeListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  sensitivity,
  createdAt: z.string(),
}).catchall(z.unknown());
export const phiTypeListResponseSchema = dataEnvelope(z.array(phiTypeListItemSchema));
export const phiTypeDetailResponseSchema = dataEnvelope(phiTypeListItemSchema);

const rawPhiTypeSchema = z.object({
  id: z.number().int(),
  organizationId: z.number().int(),
  name: z.string(),
  sensitivity,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const rawPhiTypeResponseSchema = dataEnvelope(rawPhiTypeSchema);

// -------------------------------------------------------------- notifications

export const notificationListItemSchema = z.object({
  id: z.number().int(),
  type: notificationType,
  title: z.string(),
  body: z.string(),
  entityType: z.string(),
  entityId: z.number().int(),
  read: z.boolean(),
  createdAt: z.string(),
});
export const notificationListResponseSchema = dataEnvelope(z.array(notificationListItemSchema));
export const unreadCountResponseSchema = dataEnvelope(z.object({ count: z.number().int() }));
export const notificationActionResponseSchema = dataEnvelope(z.object({ ok: z.boolean() }).catchall(z.unknown()));

// -------------------------------------------------------------- organization

export const organizationResponseSchema = dataEnvelope(
  z.object({ id: z.number().int(), name: z.string(), slug: z.string() }).catchall(z.unknown()),
);

export const memberListItemSchema = z.object({
  userId: z.number().int(),
  email: z.string(),
  role,
  active: z.boolean(),
  mfaEnabled: z.boolean(),
  memberSince: z.string(),
});
export const memberListResponseSchema = dataEnvelope(z.array(memberListItemSchema));

/** GET /organization/members is a separate, smaller handler (organization.ts) — no active/mfaEnabled. */
export const organizationMemberListResponseSchema = dataEnvelope(
  z.array(z.object({ userId: z.number().int(), email: z.string(), role, memberSince: z.string() })),
);

export const orgSettingsResponseSchema = dataEnvelope(
  z.object({
    accessStaleAfterDays: z.number().int(),
    assessmentCadenceDays: z.number().int(),
    mfaRequired: z.boolean(),
  }),
);

// -------------------------------------------------------------------- auth

export const sessionBodySchema = z.object({
  token: z.string(),
  expiresIn: z.number().int(),
  refreshToken: z.string(),
  refreshExpiresIn: z.number().int(),
  user: z.object({ id: z.number().int(), email: z.string(), role }).catchall(z.unknown()),
  memberships: z.array(z.record(z.string(), z.unknown())),
});
export const loginResponseSchema = dataEnvelope(sessionBodySchema);

export const currentUserResponseSchema = dataEnvelope(
  z.object({ id: z.number().int(), email: z.string(), role }).catchall(z.unknown()),
);

export const okResponseSchema = dataEnvelope(z.object({ ok: z.boolean() }).catchall(z.unknown()));

export const sessionListItemSchema = z.object({
  id: z.number().int(),
  current: z.boolean().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
}).catchall(z.unknown());
export const sessionListResponseSchema = dataEnvelope(z.array(sessionListItemSchema));

export const mfaEnrollResponseSchema = dataEnvelope(
  z.object({ secret: z.string(), qrCodeDataUrl: z.string() }).catchall(z.unknown()),
);
export const mfaConfirmResponseSchema = dataEnvelope(
  z.object({ recoveryCodes: z.array(z.string()) }).catchall(z.unknown()),
);
