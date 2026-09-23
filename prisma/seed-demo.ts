import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/services/authService.js";
import { recordAudit } from "../src/services/auditService.js";
import {
  assessAsset, assessVendor, recalculateAsset, recalculateVendor,
} from "../src/services/riskEngine.js";
import type { TenantContext } from "../src/lib/tenant.js";
import type { AuditAction } from "../src/generated/prisma/client.js";

/**
 * Safe demo seed for Drishti.
 *
 * ## How this differs from `prisma/seed.ts`
 *
 * The original seed TRUNCATEs every table and rebuilds from scratch. That is
 * the right tool for a development database you own outright, and completely
 * wrong for a demo database that already holds data someone cares about.
 *
 * This one never deletes anything. It contains no `deleteMany`, no `TRUNCATE`,
 * no `DROP`, and no migration reset -- grep for them; they are not here. Every
 * write is an upsert or a find-or-create keyed on something stable, so running
 * it ten times leaves exactly the same database as running it once.
 *
 * ## Blast radius
 *
 * Everything it touches lives inside one organisation, looked up by slug
 * (`DEMO_ORG_SLUG`, default `drishti-demo`). Records in any other organisation
 * are never read for writing and never modified. Pointing this at a production
 * database would create a demo tenant beside the real one rather than
 * disturbing it -- though you still should not do that.
 *
 * ## Why risk is not hardcoded
 *
 * Scores are produced by the real risk engine after the graph exists, not
 * written as literals. That means the demo's numbers are derived from its own
 * assets, access, vendors, controls and threats by exactly the code paths a
 * customer's data would take. A hardcoded 87.5 would be a fabricated metric,
 * and the whole point of the product is that its numbers come from somewhere.
 *
 * Usage:  npm run db:seed:demo
 */

const ORG_SLUG = process.env.DEMO_ORG_SLUG ?? "drishti-demo";
const ORG_NAME = process.env.DEMO_ORG_NAME ?? "Drishti Demo Healthcare";

const day = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * day);
const daysAhead = (n: number) => new Date(Date.now() + n * day);
const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);

/**
 * Counters, so the summary can show what was created versus what was already
 * there -- and so a test can assert that a second run creates nothing.
 *
 * Reset at the top of `seedDemo` rather than only initialised here, because
 * the seed is callable as a function and a second call in the same process
 * must not inherit the first call's tallies.
 */
const created: Record<string, number> = {};
const reused: Record<string, number> = {};
const bump = (bucket: Record<string, number>, key: string) => {
  bucket[key] = (bucket[key] ?? 0) + 1;
};

export type SeedSummary = {
  created: Record<string, number>;
  reused: Record<string, number>;
  organizationId: number;
};

// ─────────────────────────────────────────────────────────── demo content
//
// Every name below is invented. There are no real patients, no real
// clinicians, no real vendors, and no real credentials anywhere in this file.

const ASSETS = [
  { key: "portal", name: "Patient Portal", type: "OTHER", phiVolume: 18_400, encrypted: true, mfaEnabled: true, assessedDaysAgo: 14 },
  { key: "ehr", name: "Cardiology EHR", type: "EHR", phiVolume: 486_000, encrypted: true, mfaEnabled: true, assessedDaysAgo: 6 },
  { key: "lab", name: "Lab Results API", type: "API", phiVolume: 72_500, encrypted: true, mfaEnabled: true, assessedDaysAgo: 28 },
  { key: "imaging", name: "Imaging Archive", type: "CLOUD_STORAGE", phiVolume: 154_000, encrypted: true, mfaEnabled: false, assessedDaysAgo: 52 },
  { key: "billing", name: "Billing Database", type: "DATABASE", phiVolume: 96_300, encrypted: false, mfaEnabled: false, assessedDaysAgo: 91 },
  { key: "warehouse", name: "Analytics Warehouse", type: "ANALYTICS", phiVolume: 312_000, encrypted: true, mfaEnabled: false, assessedDaysAgo: 19 },
  { key: "claims", name: "Claims Gateway", type: "API", phiVolume: 88_700, encrypted: false, mfaEnabled: false, assessedDaysAgo: null },
  { key: "telehealth", name: "Telehealth Platform", type: "OTHER", phiVolume: 34_200, encrypted: true, mfaEnabled: true, assessedDaysAgo: 33 },
  // The one nobody wants to talk about. Every exposure amplifier the engine
  // looks for is true of it, and no control has ever been applied -- so it
  // earns the top band from the graph rather than from a hardcoded score.
  { key: "legacy", name: "Legacy Records Exchange", type: "DATABASE", phiVolume: 521_000, encrypted: false, mfaEnabled: false, assessedDaysAgo: null },
] as const;

const PHI_TYPES = [
  { key: "clinical", name: "Clinical Notes", sensitivity: "HIGH" },
  { key: "demographic", name: "Demographics", sensitivity: "LOW" },
  { key: "financial", name: "Billing & Claims", sensitivity: "MEDIUM" },
  { key: "genomic", name: "Genomic Sequences", sensitivity: "CRITICAL" },
] as const;

const ASSET_PHI = [
  { asset: "portal", phi: "demographic", recordsPerDay: 18_400 },
  { asset: "ehr", phi: "clinical", recordsPerDay: 41_200 },
  { asset: "ehr", phi: "demographic", recordsPerDay: 38_900 },
  { asset: "ehr", phi: "genomic", recordsPerDay: 1_150 },
  { asset: "lab", phi: "clinical", recordsPerDay: 12_800 },
  { asset: "imaging", phi: "clinical", recordsPerDay: 9_400 },
  { asset: "billing", phi: "financial", recordsPerDay: 22_600 },
  { asset: "billing", phi: "demographic", recordsPerDay: 22_600 },
  { asset: "warehouse", phi: "clinical", recordsPerDay: 54_000 },
  { asset: "warehouse", phi: "genomic", recordsPerDay: 2_300 },
  { asset: "claims", phi: "financial", recordsPerDay: 19_800 },
  { asset: "telehealth", phi: "clinical", recordsPerDay: 6_100 },
  { asset: "legacy", phi: "clinical", recordsPerDay: 31_500 },
  { asset: "legacy", phi: "demographic", recordsPerDay: 31_500 },
  { asset: "legacy", phi: "financial", recordsPerDay: 14_200 },
] as const;

const FLOWS = [
  { source: "portal", target: "ehr", phi: "demographic", recordsPerDay: 18_400, encrypted: true },
  { source: "ehr", target: "billing", phi: "financial", recordsPerDay: 22_600, encrypted: false },
  { source: "ehr", target: "warehouse", phi: "clinical", recordsPerDay: 41_200, encrypted: true },
  { source: "ehr", target: "warehouse", phi: "genomic", recordsPerDay: 1_150, encrypted: true },
  { source: "lab", target: "ehr", phi: "clinical", recordsPerDay: 12_800, encrypted: true },
  { source: "imaging", target: "warehouse", phi: "clinical", recordsPerDay: 9_400, encrypted: false },
  { source: "billing", target: "claims", phi: "financial", recordsPerDay: 19_800, encrypted: false },
  { source: "telehealth", target: "ehr", phi: "clinical", recordsPerDay: 6_100, encrypted: true },
  { source: "legacy", target: "claims", phi: "financial", recordsPerDay: 14_200, encrypted: false },
  { source: "legacy", target: "warehouse", phi: "clinical", recordsPerDay: 31_500, encrypted: false },
] as const;

const IDENTITIES = [
  { key: "ortiz", displayName: "Dr. Lena Ortiz", email: "l.ortiz@drishti.demo", kind: "USER", department: "Cardiology", role: "VIEWER", active: true, mfaEnabled: true },
  { key: "adeyemi", displayName: "Samuel Adeyemi", email: "s.adeyemi@drishti.demo", kind: "USER", department: "IT Infrastructure", role: "ADMIN", active: true, mfaEnabled: true },
  { key: "raman", displayName: "Priya Raman", email: "p.raman@drishti.demo", kind: "USER", department: "Revenue Cycle", role: "ANALYST", active: true, mfaEnabled: false },
  { key: "brandt", displayName: "Tomas Brandt (contractor)", email: "t.brandt@contractor.invalid", kind: "USER", department: "Radiology", role: "ANALYST", active: false, mfaEnabled: false },
  { key: "svc-sync", displayName: "svc-analytics-sync", email: null, kind: "SERVICE_ACCOUNT", department: "Data Platform", role: "ANALYST", active: true, mfaEnabled: false },
  { key: "svc-claims", displayName: "svc-claims-bridge", email: null, kind: "SERVICE_ACCOUNT", department: "Revenue Cycle", role: "ANALYST", active: true, mfaEnabled: false },
] as const;

/**
 * Grants chosen so the access register shows every flag the product detects:
 * a stale one, a never-used service account, a deactivated contractor who
 * still holds ADMIN, and elevated access on high-volume assets.
 */
const GRANTS = [
  { identity: "ortiz", asset: "ehr", level: "READ", grantedDaysAgo: 420, usedDaysAgo: 1 },
  { identity: "ortiz", asset: "imaging", level: "READ", grantedDaysAgo: 400, usedDaysAgo: 3 },
  { identity: "adeyemi", asset: "ehr", level: "ADMIN", grantedDaysAgo: 610, usedDaysAgo: 2 },
  { identity: "adeyemi", asset: "warehouse", level: "ADMIN", grantedDaysAgo: 540, usedDaysAgo: 5 },
  { identity: "raman", asset: "billing", level: "WRITE", grantedDaysAgo: 300, usedDaysAgo: 4 },
  { identity: "raman", asset: "claims", level: "WRITE", grantedDaysAgo: 260, usedDaysAgo: 128 },
  { identity: "brandt", asset: "imaging", level: "ADMIN", grantedDaysAgo: 520, usedDaysAgo: 247 },
  { identity: "svc-sync", asset: "warehouse", level: "WRITE", grantedDaysAgo: 480, usedDaysAgo: 1 },
  { identity: "svc-claims", asset: "claims", level: "WRITE", grantedDaysAgo: 700, usedDaysAgo: null },
  { identity: "adeyemi", asset: "legacy", level: "ADMIN", grantedDaysAgo: 900, usedDaysAgo: 30 },
  { identity: "raman", asset: "legacy", level: "WRITE", grantedDaysAgo: 880, usedDaysAgo: 210 },
  { identity: "brandt", asset: "legacy", level: "ADMIN", grantedDaysAgo: 870, usedDaysAgo: 300 },
  { identity: "svc-sync", asset: "legacy", level: "WRITE", grantedDaysAgo: 850, usedDaysAgo: 2 },
] as const;

const VENDORS = [
  { key: "northgate", name: "Northgate Claims Services", baaStatus: "MISSING", phiVolume: 88_700, assessedDaysAgo: null, assets: ["claims", "billing", "legacy"] },
  { key: "vertex", name: "Vertex Imaging Cloud", baaStatus: "SIGNED", phiVolume: 154_000, assessedDaysAgo: 120, assets: ["imaging"] },
  { key: "helix", name: "Helix Genomics Partners", baaStatus: "PENDING", phiVolume: 3_450, assessedDaysAgo: 210, assets: ["warehouse"] },
  { key: "lumen", name: "Lumen Analytics", baaStatus: "SIGNED", phiVolume: 312_000, assessedDaysAgo: 45, assets: ["warehouse"] },
  { key: "archive9", name: "Archive Nine Backup", baaStatus: "EXPIRED", phiVolume: 486_000, assessedDaysAgo: 500, assets: ["ehr", "legacy"] },
] as const;

const THREATS = [
  { key: "tor", asset: "claims", severity: "CRITICAL", status: "OPEN", title: "Authenticated session from anonymising network", description: "The claims gateway accepted credentials from an anonymising exit node. The gateway is internet-facing and unencrypted in transit.", hoursAgo: 9, resolvedHoursAgo: null },
  { key: "bulk", asset: "billing", severity: "CRITICAL", status: "INVESTIGATING", title: "Bulk export from billing database", description: "1,204 records exported to an unmanaged endpoint in a single session, far outside the normal daily pattern for that account.", hoursAgo: 31, resolvedHoursAgo: null },
  { key: "escalation", asset: "ehr", severity: "HIGH", status: "OPEN", title: "Repeated privilege escalation attempts", description: "An analyst-level account issued four consecutive role-change requests against the EHR within two minutes.", hoursAgo: 58, resolvedHoursAgo: null },
  { key: "scan", asset: "portal", severity: "MEDIUM", status: "RESOLVED", title: "Credential stuffing against the patient portal", description: "Distributed login attempts across 900 accounts. Rate limiting held; no session was established.", hoursAgo: 190, resolvedHoursAgo: 150 },
  { key: "legacy-exfil", asset: "legacy", severity: "CRITICAL", status: "OPEN", title: "Sustained outbound transfer from legacy exchange", description: "14 GB transferred from the legacy records exchange to an unrecognised destination over six hours. The system is unencrypted at rest and in transit.", hoursAgo: 4, resolvedHoursAgo: null },
  { key: "noise", asset: "lab", severity: "LOW", status: "FALSE_POSITIVE", title: "Anomalous query volume on the lab API", description: "Flagged by the detector; traced to a scheduled reconciliation job that had been rescheduled.", hoursAgo: 260, resolvedHoursAgo: 240 },
] as const;

/**
 * Controls spanning every category, deliberately mixed in maturity so the
 * register shows real variation rather than a wall of green. Two are
 * effective, three partial, one ineffective, one planned, one absent.
 */
const CONTROLS = [
  { key: "mfa", name: "Multi-Factor Authentication", description: "MFA required for all interactive access to systems holding PHI.", category: "ACCESS", status: "PARTIAL", effectiveness: "PARTIALLY_EFFECTIVE", owner: "Samuel Adeyemi", frameworkRef: "HIPAA 164.312(d)", reviewedDaysAgo: 40, assets: ["portal", "ehr", "lab", "telehealth"] },
  { key: "enc-rest", name: "Encryption at Rest", description: "AES-256 for all stored PHI, with keys held in a managed KMS.", category: "ENCRYPTION", status: "IMPLEMENTED", effectiveness: "EFFECTIVE", owner: "Samuel Adeyemi", frameworkRef: "HIPAA 164.312(a)(2)(iv)", reviewedDaysAgo: 22, assets: ["portal", "ehr", "lab", "imaging", "warehouse", "telehealth"] },
  { key: "enc-transit", name: "Encryption in Transit", description: "TLS 1.2 or better on every interface carrying PHI between systems.", category: "ENCRYPTION", status: "PARTIAL", effectiveness: "PARTIALLY_EFFECTIVE", owner: "Samuel Adeyemi", frameworkRef: "HIPAA 164.312(e)(1)", reviewedDaysAgo: 22, assets: ["portal", "ehr", "lab", "telehealth"] },
  { key: "least-priv", name: "Least Privilege Access", description: "Access granted at the lowest level required, re-evaluated on role change.", category: "ACCESS", status: "PARTIAL", effectiveness: "INEFFECTIVE", owner: "Priya Raman", frameworkRef: "HIPAA 164.308(a)(4)", reviewedDaysAgo: 140, assets: ["billing", "claims", "imaging"] },
  { key: "access-review", name: "Periodic Access Review", description: "Every access grant reviewed and attested at least quarterly.", category: "GOVERNANCE", status: "PLANNED", effectiveness: "NOT_ASSESSED", owner: "Priya Raman", frameworkRef: "HIPAA 164.308(a)(3)(ii)(B)", reviewedDaysAgo: null, assets: [] },
  { key: "vendor-baa", name: "Vendor BAA Management", description: "A signed Business Associate Agreement before any vendor touches PHI.", category: "VENDOR", status: "PARTIAL", effectiveness: "INEFFECTIVE", owner: "Priya Raman", frameworkRef: "HIPAA 164.308(b)(1)", reviewedDaysAgo: 95, assets: ["claims", "billing", "imaging"] },
  { key: "logging", name: "Security Logging", description: "All PHI access logged with actor, timestamp and source address.", category: "MONITORING", status: "IMPLEMENTED", effectiveness: "EFFECTIVE", owner: "Samuel Adeyemi", frameworkRef: "HIPAA 164.312(b)", reviewedDaysAgo: 11, assets: ["ehr", "billing", "claims", "warehouse"] },
  { key: "backup", name: "Backup & Recovery", description: "Daily encrypted backups with a tested quarterly restore.", category: "RESILIENCE", status: "NOT_IMPLEMENTED", effectiveness: "NOT_ASSESSED", owner: "Samuel Adeyemi", frameworkRef: "HIPAA 164.308(a)(7)", reviewedDaysAgo: null, assets: [] },
] as const;

const POLICIES = [
  { name: "Access Control Policy", description: "How access to systems holding PHI is requested, approved, reviewed and revoked.", status: "ACTIVE", owner: "Priya Raman", evidenceRef: "policies/access-control-v4.pdf", reviewInDays: 60, controls: ["mfa", "least-priv", "access-review"] },
  { name: "PHI Encryption Policy", description: "Required encryption for PHI at rest and in transit, and key management responsibilities.", status: "ACTIVE", owner: "Samuel Adeyemi", evidenceRef: "policies/encryption-v3.pdf", reviewInDays: 130, controls: ["enc-rest", "enc-transit"] },
  { name: "Vendor Risk Management Policy", description: "Due diligence, BAA execution and reassessment cadence for vendors that touch PHI.", status: "UNDER_REVIEW", owner: "Priya Raman", evidenceRef: null, reviewInDays: -21, controls: ["vendor-baa"] },
  { name: "Incident Response Policy", description: "Detection, triage, containment and notification duties following a suspected breach.", status: "ACTIVE", owner: "Samuel Adeyemi", evidenceRef: "policies/incident-response-v2.pdf", reviewInDays: 90, controls: ["logging"] },
  { name: "Data Retention Policy", description: "Retention periods for each PHI category, and the disposal method for each.", status: "DRAFT", owner: "Priya Raman", evidenceRef: null, reviewInDays: null, controls: ["backup"] },
] as const;

/**
 * Assessor judgement only. Exposure and control gap are derived by the engine
 * from the graph above, which is why they are absent here.
 */
const ASSESSMENTS = [
  { asset: "portal", likelihood: 2, impact: 2 },
  { asset: "ehr", likelihood: 4, impact: 5 },
  { asset: "lab", likelihood: 3, impact: 3 },
  { asset: "imaging", likelihood: 3, impact: 4 },
  { asset: "billing", likelihood: 5, impact: 4 },
  { asset: "warehouse", likelihood: 4, impact: 5 },
  { asset: "claims", likelihood: 5, impact: 4 },
  { asset: "telehealth", likelihood: 2, impact: 3 },
  { asset: "legacy", likelihood: 5, impact: 5 },
] as const;

const VENDOR_ASSESSMENTS = [
  { vendor: "northgate", likelihood: 5, impact: 4 },
  { vendor: "vertex", likelihood: 2, impact: 4 },
  { vendor: "helix", likelihood: 3, impact: 5 },
  { vendor: "lumen", likelihood: 2, impact: 5 },
  { vendor: "archive9", likelihood: 4, impact: 5 },
] as const;

/** Every finding points at the record that raised it. None are orphans. */
const REMEDIATIONS = [
  {
    title: "Billing Database stores PHI without encryption at rest",
    description: "Billing Database holds 96,300 PHI records with at-rest encryption disabled, and receives an unencrypted feed from the Cardiology EHR.",
    recommendation: "Enable AES-256 at rest and re-key the volume during the next maintenance window. Then enable TLS on the EHR to billing feed.",
    severity: "CRITICAL", status: "OPEN", source: "RISK",
    owner: "admin", dueInDays: 10, resolvedDaysAgo: null,
    asset: "billing",
  },
  {
    title: "Decommission or secure the Legacy Records Exchange",
    description: "The legacy exchange holds 521,000 PHI records unencrypted, has no MFA, is reachable by two vendors and four identities including a deactivated contractor, and is the subject of an active exfiltration alert. No control has ever been applied to it.",
    recommendation: "Freeze outbound transfer, revoke the contractor grant, and agree a decommissioning date. If it must remain, encrypt at rest and place it behind MFA before the next reporting period.",
    severity: "CRITICAL", status: "OPEN", source: "RISK",
    owner: "admin", dueInDays: 7, resolvedDaysAgo: null,
    asset: "legacy",
  },
  {
    title: "Northgate Claims Services has no signed BAA",
    description: "Northgate Claims Services can reach two systems holding PHI and has never returned a signed Business Associate Agreement.",
    recommendation: "Suspend the vendor's access until a BAA is executed, or complete execution before the next claims cycle.",
    severity: "CRITICAL", status: "IN_PROGRESS", source: "VENDOR",
    owner: "analyst", dueInDays: 5, resolvedDaysAgo: null,
    vendor: "northgate",
  },
  {
    title: "Anonymising-network session reached the claims gateway",
    description: "The claims gateway accepted an authenticated session from an anonymising exit node. The gateway is internet-facing and unencrypted in transit.",
    recommendation: "Terminate the session, rotate the credential involved, and place the gateway behind the IP allowlist.",
    severity: "CRITICAL", status: "OPEN", source: "THREAT",
    owner: "admin", dueInDays: 2, resolvedDaysAgo: null,
    threat: "tor",
  },
  {
    title: "Deactivated contractor retains ADMIN access to Imaging Archive",
    description: "A deactivated contractor identity still holds ADMIN access to the Imaging Archive, last exercised over eight months ago.",
    recommendation: "Revoke the grant and confirm no automation depends on the credential.",
    severity: "HIGH", status: "OPEN", source: "ACCESS",
    owner: "analyst", dueInDays: 3, resolvedDaysAgo: null,
    identity: "brandt", asset: "imaging",
  },
  {
    title: "MFA not enforced on the Analytics Warehouse",
    description: "The Analytics Warehouse holds 312,000 PHI records and did not require MFA for interactive access.",
    recommendation: "Extend the MFA control to the analytics estate and verify coverage.",
    severity: "HIGH", status: "RESOLVED", source: "CONTROL",
    owner: "admin", dueInDays: null, resolvedDaysAgo: 4,
    control: "mfa",
  },
  {
    title: "Unused service account holds WRITE access to the claims gateway",
    description: "svc-claims-bridge holds WRITE access to the claims gateway and has no recorded use since it was granted.",
    recommendation: "Retire the service account, or document the integration that requires it to remain.",
    severity: "MEDIUM", status: "ACCEPTED", source: "ACCESS",
    owner: "analyst", dueInDays: null, resolvedDaysAgo: 2,
    identity: "svc-claims", asset: "claims",
  },
] as const;

/**
 * Historical audit events, written so the trail is not empty on a fresh demo.
 *
 * Only actions this system genuinely performs, attributed to the demo admin --
 * no invented actor ids. Live events (assessments, recomputations) are written
 * by the engine itself further down, not listed here.
 */
const HISTORICAL_AUDIT: Array<{
  action: AuditAction; entityType: string; entity: string; kind: "asset" | "vendor" | "control";
  metadata: Record<string, unknown>; daysAgo: number;
}> = [
  { action: "ASSET_CREATED", entityType: "Asset", entity: "ehr", kind: "asset", metadata: { name: "Cardiology EHR", discoveredBy: "estate import" }, daysAgo: 96 },
  { action: "ASSET_CREATED", entityType: "Asset", entity: "warehouse", kind: "asset", metadata: { name: "Analytics Warehouse", discoveredBy: "estate import" }, daysAgo: 96 },
  { action: "ASSET_UPDATED", entityType: "Asset", entity: "imaging", kind: "asset", metadata: { changes: { mfaEnabled: { from: true, to: false } } }, daysAgo: 54 },
  { action: "VENDOR_CREATED", entityType: "Vendor", entity: "northgate", kind: "vendor", metadata: { name: "Northgate Claims Services", baaStatus: "MISSING" }, daysAgo: 88 },
  { action: "VENDOR_UPDATED", entityType: "Vendor", entity: "archive9", kind: "vendor", metadata: { changes: { baaStatus: { from: "SIGNED", to: "EXPIRED" } } }, daysAgo: 30 },
  { action: "CONTROL_UPDATED", entityType: "Control", entity: "least-priv", kind: "control", metadata: { changes: { effectiveness: { from: "PARTIALLY_EFFECTIVE", to: "INEFFECTIVE" } } }, daysAgo: 18 },
  { action: "ACCESS_REVIEWED", entityType: "Control", entity: "access-review", kind: "control", metadata: { note: "Quarterly review cycle opened" }, daysAgo: 12 },
];

// ──────────────────────────────────────────────────────────────── helpers

/**
 * Creates an audit row only if an identical one is not already present.
 *
 * AuditEvent has no unique constraint -- it is an append-only log, and that is
 * correct. So idempotency here is a deliberate existence check on
 * (action, entityType, entityId) within the organisation, rather than a
 * database guarantee.
 */
async function ensureAudit(
  ctx: TenantContext,
  input: { action: AuditAction; entityType: string; entityId: number; metadata: unknown; createdAt?: Date },
): Promise<boolean> {
  const existing = await prisma.auditEvent.findFirst({
    where: {
      organizationId: ctx.organizationId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
    },
    select: { id: true },
  });
  if (existing) {
    bump(reused, "auditEvents");
    return false;
  }

  await recordAudit(ctx, {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
  });

  // recordAudit stamps createdAt with now(). Backdating historical entries is
  // a separate update so the trail reads as a history rather than as a burst
  // of activity at seed time.
  if (input.createdAt) {
    const row = await prisma.auditEvent.findFirst({
      where: {
        organizationId: ctx.organizationId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
      },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    if (row) {
      await prisma.auditEvent.update({
        where: { id: row.id },
        data: { createdAt: input.createdAt },
      });
    }
  }

  bump(created, "auditEvents");
  return true;
}

export async function seedDemo(options: { quiet?: boolean } = {}): Promise<SeedSummary> {
  for (const k of Object.keys(created)) delete created[k];
  for (const k of Object.keys(reused)) delete reused[k];

  const log = (...args: unknown[]) => {
    if (!options.quiet) console.log(...args);
  };

  const password = process.env.DEMO_USER_PASSWORD;
  if (!password) {
    throw new Error(
      "DEMO_USER_PASSWORD is not set — see .env.example. The demo accounts need a password and this seed will not invent one.",
    );
  }
  if (password.length < 8) {
    throw new Error("DEMO_USER_PASSWORD must be at least 8 characters.");
  }

  log(`[demo-seed] target organisation: ${ORG_NAME} (${ORG_SLUG})`);
  log("[demo-seed] non-destructive: no truncate, no delete, upserts only");

  // ── organisation ──────────────────────────────────────────────────────
  const existingOrg = await prisma.organization.findUnique({ where: { slug: ORG_SLUG } });
  const org = existingOrg
    ?? (await prisma.organization.create({ data: { name: ORG_NAME, slug: ORG_SLUG } }));
  bump(existingOrg ? reused : created, "organization");
  const organizationId = org.id;

  // ── users and membership ──────────────────────────────────────────────
  const passwordHash = await hashPassword(password);
  const USERS = [
    { email: `admin@${ORG_SLUG}.invalid`, role: "ADMIN" as const },
    { email: `analyst@${ORG_SLUG}.invalid`, role: "ANALYST" as const },
    { email: `viewer@${ORG_SLUG}.invalid`, role: "VIEWER" as const },
  ];

  const userIds: Record<string, number> = {};
  for (const u of USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    // An existing account keeps its password. Overwriting it would be a
    // surprise for anyone who had changed it, and this seed does not own
    // records it did not create.
    const user = existing
      ?? (await prisma.user.create({
        data: { email: u.email, role: u.role, passwordHash },
      }));
    bump(existing ? reused : created, "users");
    userIds[u.role] = user.id;

    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
    });
    if (!member) {
      await prisma.organizationMember.create({
        data: { userId: user.id, organizationId, role: u.role },
      });
      bump(created, "memberships");
    } else {
      bump(reused, "memberships");
    }
  }

  const adminId = userIds.ADMIN!;
  const analystId = userIds.ANALYST!;

  /** Everything below runs as the demo admin, so audit rows name a real user. */
  const ctx: TenantContext = {
    userId: adminId,
    email: `admin@${ORG_SLUG}.invalid`,
    role: "ADMIN",
    organizationId,
  };

  // ── assets ────────────────────────────────────────────────────────────
  const assetIds: Record<string, number> = {};
  for (const a of ASSETS) {
    const before = await prisma.asset.findUnique({
      where: { organizationId_name: { organizationId, name: a.name } },
    });
    const row = await prisma.asset.upsert({
      where: { organizationId_name: { organizationId, name: a.name } },
      update: {},   // an existing asset is left exactly as the operator left it
      create: {
        organizationId, name: a.name, type: a.type,
        phiVolume: a.phiVolume, encrypted: a.encrypted, mfaEnabled: a.mfaEnabled,
        lastAssessedAt: a.assessedDaysAgo === null ? null : daysAgo(a.assessedDaysAgo),
      },
    });
    assetIds[a.key] = row.id;
    bump(before ? reused : created, "assets");
  }
  const assetId = (k: string) => assetIds[k]!;

  // ── PHI types and their asset links ───────────────────────────────────
  const phiIds: Record<string, number> = {};
  for (const p of PHI_TYPES) {
    const before = await prisma.pHIType.findUnique({
      where: { organizationId_name: { organizationId, name: p.name } },
    });
    const row = await prisma.pHIType.upsert({
      where: { organizationId_name: { organizationId, name: p.name } },
      update: {},
      create: { organizationId, name: p.name, sensitivity: p.sensitivity },
    });
    phiIds[p.key] = row.id;
    bump(before ? reused : created, "phiTypes");
  }
  const phiId = (k: string) => phiIds[k]!;

  for (const link of ASSET_PHI) {
    const key = { assetId: assetId(link.asset), phiTypeId: phiId(link.phi) };
    const before = await prisma.assetPHI.findUnique({ where: { assetId_phiTypeId: key } });
    await prisma.assetPHI.upsert({
      where: { assetId_phiTypeId: key },
      update: {},
      create: { ...key, recordsPerDay: link.recordsPerDay },
    });
    bump(before ? reused : created, "assetPhiLinks");
  }

  // ── data flows ────────────────────────────────────────────────────────
  for (const f of FLOWS) {
    const key = {
      sourceAssetId: assetId(f.source),
      targetAssetId: assetId(f.target),
      phiTypeId: phiId(f.phi),
    };
    const before = await prisma.dataFlow.findUnique({
      where: { sourceAssetId_targetAssetId_phiTypeId: key },
    });
    await prisma.dataFlow.upsert({
      where: { sourceAssetId_targetAssetId_phiTypeId: key },
      update: {},
      create: { organizationId, ...key, recordsPerDay: f.recordsPerDay, encrypted: f.encrypted },
    });
    bump(before ? reused : created, "dataFlows");
  }

  // ── identities and access ─────────────────────────────────────────────
  const identityIds: Record<string, number> = {};
  for (const i of IDENTITIES) {
    const before = await prisma.identity.findUnique({
      where: { organizationId_displayName: { organizationId, displayName: i.displayName } },
    });
    const row = await prisma.identity.upsert({
      where: { organizationId_displayName: { organizationId, displayName: i.displayName } },
      update: {},
      create: {
        organizationId, displayName: i.displayName, email: i.email, kind: i.kind,
        department: i.department, role: i.role, active: i.active, mfaEnabled: i.mfaEnabled,
      },
    });
    identityIds[i.key] = row.id;
    bump(before ? reused : created, "identities");
  }
  const identityId = (k: string) => identityIds[k]!;

  const grantIds: Record<string, number> = {};
  for (const g of GRANTS) {
    const key = { identityId: identityId(g.identity), assetId: assetId(g.asset) };
    const before = await prisma.accessGrant.findUnique({
      where: { identityId_assetId: key },
    });
    const row = await prisma.accessGrant.upsert({
      where: { identityId_assetId: key },
      update: {},
      create: {
        organizationId, ...key, level: g.level,
        grantedAt: daysAgo(g.grantedDaysAgo),
        lastUsedAt: g.usedDaysAgo === null ? null : daysAgo(g.usedDaysAgo),
      },
    });
    grantIds[`${g.identity}:${g.asset}`] = row.id;
    bump(before ? reused : created, "accessGrants");
  }

  // ── vendors ───────────────────────────────────────────────────────────
  const vendorIds: Record<string, number> = {};
  for (const v of VENDORS) {
    const before = await prisma.vendor.findUnique({
      where: { organizationId_name: { organizationId, name: v.name } },
    });
    const row = await prisma.vendor.upsert({
      where: { organizationId_name: { organizationId, name: v.name } },
      update: {},
      create: {
        organizationId, name: v.name, baaStatus: v.baaStatus, phiVolume: v.phiVolume,
        lastAssessedAt: v.assessedDaysAgo === null ? null : daysAgo(v.assessedDaysAgo),
      },
    });
    vendorIds[v.key] = row.id;
    bump(before ? reused : created, "vendors");
  }
  const vendorId = (k: string) => vendorIds[k]!;

  // ── threats ───────────────────────────────────────────────────────────
  const threatIds: Record<string, number> = {};
  for (const t of THREATS) {
    const key = { assetId: assetId(t.asset), title: t.title };
    const before = await prisma.threat.findUnique({ where: { assetId_title: key } });
    const row = await prisma.threat.upsert({
      where: { assetId_title: key },
      update: {},
      create: {
        organizationId, ...key, severity: t.severity, status: t.status,
        description: t.description,
        detectedAt: hoursAgo(t.hoursAgo),
        resolvedAt: t.resolvedHoursAgo === null ? null : hoursAgo(t.resolvedHoursAgo),
      },
    });
    threatIds[t.key] = row.id;
    bump(before ? reused : created, "threats");
  }
  const threatId = (k: string) => threatIds[k]!;

  // ── controls and their asset links ────────────────────────────────────
  const controlIds: Record<string, number> = {};
  for (const c of CONTROLS) {
    const before = await prisma.control.findUnique({
      where: { organizationId_name: { organizationId, name: c.name } },
    });
    const row = await prisma.control.upsert({
      where: { organizationId_name: { organizationId, name: c.name } },
      update: {},
      create: {
        organizationId, name: c.name, description: c.description, category: c.category,
        status: c.status, effectiveness: c.effectiveness, owner: c.owner,
        frameworkRef: c.frameworkRef,
        lastReviewedAt: c.reviewedDaysAgo === null ? null : daysAgo(c.reviewedDaysAgo),
      },
    });
    controlIds[c.key] = row.id;
    bump(before ? reused : created, "controls");
  }
  const controlId = (k: string) => controlIds[k]!;

  // ── policies ──────────────────────────────────────────────────────────
  for (const p of POLICIES) {
    const before = await prisma.policy.findUnique({
      where: { organizationId_name: { organizationId, name: p.name } },
    });
    const row = await prisma.policy.upsert({
      where: { organizationId_name: { organizationId, name: p.name } },
      update: {},
      create: {
        organizationId, name: p.name, description: p.description, status: p.status,
        owner: p.owner, evidenceRef: p.evidenceRef,
        reviewDueAt: p.reviewInDays === null ? null : daysAhead(p.reviewInDays),
      },
    });
    bump(before ? reused : created, "policies");

    for (const c of p.controls) {
      const key = { policyId: row.id, controlId: controlId(c) };
      const linked = await prisma.policyControl.findUnique({
        where: { policyId_controlId: key },
      });
      await prisma.policyControl.upsert({ where: { policyId_controlId: key }, update: {}, create: key });
      bump(linked ? reused : created, "policyControlLinks");
    }
  }

  // ── risk, through the real engine ─────────────────────────────────────
  //
  // Deliberately BEFORE controls are applied to assets. The assessor records
  // likelihood and impact; the engine derives exposure and control gap from
  // the graph as it stands, which at this point has no controls on anything --
  // so every asset starts at the maximum control gap.
  //
  // Applying the controls below then moves the scores down, which is what
  // gives the trend charts a second point and a story anyone can follow:
  // "this is what it looked like before we had controls, and after".
  //
  // Only for subjects with no assessment yet. Re-running must not append a
  // second RiskHistory row for a score that has not moved -- history is
  // append-only, so idempotency here is "do not assess what is already
  // assessed" rather than an upsert.
  // Vendors are assessed before they are given reach, for the same reason
  // assets are assessed before controls: the onboarding story is "we assessed
  // this vendor, then we connected them to systems", and connecting them is
  // what moves their exposure.
  for (const v of VENDOR_ASSESSMENTS) {
    const id = vendorId(v.vendor);
    const existing = await prisma.vendorRisk.findUnique({ where: { vendorId: id } });
    if (existing) {
      bump(reused, "vendorRisks");
      continue;
    }
    await assessVendor(ctx, id, { likelihood: v.likelihood, impact: v.impact });
    bump(created, "vendorRisks");
  }

  // ── grant vendors their reach, which moves their scores ───────────────
  const touchedVendors = new Set<number>();
  for (const v of VENDORS) {
    for (const a of v.assets) {
      const key = { vendorId: vendorId(v.key), assetId: assetId(a) };
      const linked = await prisma.vendorAssetAccess.findUnique({
        where: { vendorId_assetId: key },
      });
      if (!linked) touchedVendors.add(key.vendorId);
      await prisma.vendorAssetAccess.upsert({
        where: { vendorId_assetId: key },
        update: {},
        create: key,
      });
      bump(linked ? reused : created, "vendorAssetLinks");
    }
  }

  for (const id of touchedVendors) {
    const moved = await recalculateVendor(ctx, id, "VENDOR_ACCESS_CHANGED");
    bump(moved ? created : reused, "vendorRiskHistory");
  }

  // Assets are assessed once vendor reach exists (it feeds their exposure)
  // but before controls are applied, so the control gap starts at its worst.
  for (const a of ASSESSMENTS) {
    const id = assetId(a.asset);
    const existing = await prisma.risk.findUnique({ where: { assetId: id } });
    if (existing) {
      bump(reused, "assetRisks");
      continue;
    }
    await assessAsset(ctx, id, { likelihood: a.likelihood, impact: a.impact });
    bump(created, "assetRisks");
  }

  // ── apply controls, which moves the scores ────────────────────────────
  //
  // This is the second data point. Linking an effective control lowers an
  // asset's derived control gap, the engine notices, and the drop is recorded
  // in RiskHistory with reason CONTROL_CHANGED -- exactly the path a customer
  // applying a control would take.
  const touchedAssets = new Set<number>();
  for (const c of CONTROLS) {
    for (const a of c.assets) {
      const key = { assetId: assetId(a), controlId: controlId(c.key) };
      const linked = await prisma.assetControl.findUnique({
        where: { assetId_controlId: key },
      });
      if (!linked) touchedAssets.add(key.assetId);
      await prisma.assetControl.upsert({ where: { assetId_controlId: key }, update: {}, create: key });
      bump(linked ? reused : created, "assetControlLinks");
    }
  }

  for (const id of touchedAssets) {
    const moved = await recalculateAsset(ctx, id, "CONTROL_CHANGED");
    bump(moved ? created : reused, "assetRiskHistory");
  }

  // ── remediation ───────────────────────────────────────────────────────
  //
  // Remediation has no unique constraint -- a real estate can legitimately
  // raise two findings with the same title -- so idempotency is a deliberate
  // lookup on (organizationId, title).
  for (const r of REMEDIATIONS) {
    const existing = await prisma.remediation.findFirst({
      where: { organizationId, title: r.title },
      select: { id: true },
    });
    if (existing) {
      bump(reused, "remediations");
      continue;
    }

    await prisma.remediation.create({
      data: {
        organizationId,
        title: r.title, description: r.description, recommendation: r.recommendation,
        severity: r.severity, status: r.status, source: r.source,
        ownerId: r.owner === "admin" ? adminId : analystId,
        dueAt: r.dueInDays === null ? null : daysAhead(r.dueInDays),
        resolvedAt: r.resolvedDaysAgo === null ? null : daysAgo(r.resolvedDaysAgo),
        assetId: "asset" in r && r.asset ? assetId(r.asset) : null,
        vendorId: "vendor" in r && r.vendor ? vendorId(r.vendor) : null,
        threatId: "threat" in r && r.threat ? threatId(r.threat) : null,
        controlId: "control" in r && r.control ? controlId(r.control) : null,
        identityId: "identity" in r && r.identity ? identityId(r.identity) : null,
      },
    });
    bump(created, "remediations");
  }

  // ── historical audit ──────────────────────────────────────────────────
  for (const e of HISTORICAL_AUDIT) {
    const entityId =
      e.kind === "asset" ? assetId(e.entity)
      : e.kind === "vendor" ? vendorId(e.entity)
      : controlId(e.entity);

    await ensureAudit(ctx, {
      action: e.action,
      entityType: e.entityType,
      entityId,
      metadata: e.metadata,
      createdAt: daysAgo(e.daysAgo),
    });
  }

  // ── summary ───────────────────────────────────────────────────────────
  const keys = [...new Set([...Object.keys(created), ...Object.keys(reused)])].sort();
  log("\n[demo-seed] done.\n");
  log("  entity                 created   already present");
  log("  ─────────────────────  ───────   ───────────────");
  for (const k of keys) {
    log(`  ${k.padEnd(21)}  ${String(created[k] ?? 0).padStart(7)}   ${String(reused[k] ?? 0).padStart(15)}`);
  }

  const totals = await prisma.$transaction([
    prisma.asset.count({ where: { organizationId } }),
    prisma.vendor.count({ where: { organizationId } }),
    prisma.control.count({ where: { organizationId } }),
    prisma.policy.count({ where: { organizationId } }),
    prisma.remediation.count({ where: { organizationId } }),
    prisma.riskHistory.count({ where: { organizationId } }),
    prisma.auditEvent.count({ where: { organizationId } }),
  ]);
  log(
    `\n[demo-seed] org ${organizationId} now holds: ` +
    `${totals[0]} assets, ${totals[1]} vendors, ${totals[2]} controls, ` +
    `${totals[3]} policies, ${totals[4]} remediations, ` +
    `${totals[5]} risk-history entries, ${totals[6]} audit events.`,
  );
  log(
    `[demo-seed] sign in as admin@${ORG_SLUG}.invalid / analyst@${ORG_SLUG}.invalid ` +
    "with DEMO_USER_PASSWORD. (Password not printed.)",
  );

  return { created: { ...created }, reused: { ...reused }, organizationId };
}

/**
 * CLI entry point, guarded so importing this module from a test does not run
 * the seed as a side effect of the import.
 */
if (process.argv[1]?.includes("seed-demo")) {
  seedDemo()
    .catch((err) => {
      console.error("[demo-seed] failed:", err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
