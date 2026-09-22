import "dotenv/config";
import type {
  AccessLevel, AssetType, BaaStatus, IdentityKind, Sensitivity,
  ThreatSeverity, ThreatStatus,
} from "../src/generated/prisma/client.js";
import { prisma } from "../src/lib/prisma.js";
import { computeRisk } from "../src/services/riskScoring.js";
import { hashPassword } from "../src/services/authService.js";

/**
 * Demo dataset for Meridian Health — a small but realistic PHI estate.
 *
 * Names and daily record volumes mirror the flows the MedGuard frontend
 * already tells a story about (Patient Portal -> EHR -> Lab/Imaging/Billing ->
 * external recipients), so the Sankey reads the same whether it is fed by
 * these rows or by the old mocks.
 *
 * Risk inputs are chosen to spread across all five bands and across eight
 * distinct likelihood x impact cells, so the matrix does not clump.
 */

type AssetSeed = {
  key: string;
  name: string;
  type: AssetType;
  phiVolume: number;
  encrypted: boolean;
  mfaEnabled: boolean;
  daysSinceAssessment: number | null;
};

const ASSETS: AssetSeed[] = [
  { key: "portal",    name: "Patient Portal",          type: "OTHER",         phiVolume: 12_400,  encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 12 },
  { key: "pharmacy",  name: "Pharmacy System",         type: "OTHER",         phiVolume: 38_900,  encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 21 },
  { key: "ehr",       name: "Epic EHR Core",           type: "EHR",           phiVolume: 412_000, encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 4 },
  { key: "lab",       name: "Lab Results API",         type: "API",           phiVolume: 64_200,  encrypted: true,  mfaEnabled: true,  daysSinceAssessment: 30 },
  { key: "imaging",   name: "Imaging Archive (S3)",    type: "CLOUD_STORAGE", phiVolume: 51_200,  encrypted: true,  mfaEnabled: false, daysSinceAssessment: 46 },
  { key: "billing",   name: "Billing Engine DB",       type: "DATABASE",      phiVolume: 87_100,  encrypted: false, mfaEnabled: false, daysSinceAssessment: 88 },
  { key: "analytics", name: "Clinical Analytics Lake", type: "ANALYTICS",     phiVolume: 229_000, encrypted: true,  mfaEnabled: false, daysSinceAssessment: 17 },
  { key: "insurance", name: "Insurance Claims Gateway", type: "API",          phiVolume: 71_300,  encrypted: false, mfaEnabled: false, daysSinceAssessment: null },
];

const PHI_TYPES: Array<{ key: string; name: string; sensitivity: Sensitivity }> = [
  { key: "clinical",    name: "Clinical",    sensitivity: "HIGH" },
  { key: "financial",   name: "Financial",   sensitivity: "MEDIUM" },
  { key: "genetic",     name: "Genetic",     sensitivity: "CRITICAL" },
  { key: "demographic", name: "Demographic", sensitivity: "LOW" },
];

/** Which PHI categories each asset holds, and at what daily volume. */
const ASSET_PHI: Array<{ asset: string; phiType: string; recordsPerDay: number }> = [
  { asset: "portal",    phiType: "demographic", recordsPerDay: 12_400 },
  { asset: "pharmacy",  phiType: "clinical",    recordsPerDay: 38_900 },
  { asset: "ehr",       phiType: "clinical",    recordsPerDay: 284_000 },
  { asset: "ehr",       phiType: "demographic", recordsPerDay: 112_000 },
  { asset: "ehr",       phiType: "genetic",     recordsPerDay: 16_000 },
  { asset: "lab",       phiType: "clinical",    recordsPerDay: 45_400 },
  { asset: "lab",       phiType: "genetic",     recordsPerDay: 18_800 },
  { asset: "imaging",   phiType: "clinical",    recordsPerDay: 51_200 },
  { asset: "billing",   phiType: "financial",   recordsPerDay: 87_100 },
  { asset: "analytics", phiType: "clinical",    recordsPerDay: 103_100 },
  { asset: "analytics", phiType: "genetic",     recordsPerDay: 18_800 },
  { asset: "analytics", phiType: "demographic", recordsPerDay: 6_400 },
  { asset: "insurance", phiType: "financial",   recordsPerDay: 71_300 },
];

/** The flow chain. Volumes vary ~14x end to end so ribbons read distinctly. */
const FLOWS: Array<{
  source: string; target: string; phiType: string; recordsPerDay: number; encrypted: boolean;
}> = [
  { source: "portal",    target: "ehr",       phiType: "demographic", recordsPerDay: 12_400, encrypted: true },
  { source: "pharmacy",  target: "ehr",       phiType: "clinical",    recordsPerDay: 38_900, encrypted: true },
  { source: "ehr",       target: "lab",       phiType: "clinical",    recordsPerDay: 64_200, encrypted: true },
  { source: "ehr",       target: "imaging",   phiType: "clinical",    recordsPerDay: 51_200, encrypted: true },
  { source: "ehr",       target: "billing",   phiType: "financial",   recordsPerDay: 87_100, encrypted: false },
  { source: "ehr",       target: "analytics", phiType: "clinical",    recordsPerDay: 29_500, encrypted: true },
  { source: "lab",       target: "analytics", phiType: "genetic",     recordsPerDay: 18_800, encrypted: true },
  { source: "imaging",   target: "analytics", phiType: "clinical",    recordsPerDay: 22_400, encrypted: true },
  { source: "billing",   target: "insurance", phiType: "financial",   recordsPerDay: 71_300, encrypted: false },
  { source: "analytics", target: "insurance", phiType: "demographic", recordsPerDay: 6_400,  encrypted: true },
];

/**
 * Assessor judgements, 1-5 each. score and band are never written by hand —
 * they come from computeRisk so the seed and the API agree by construction.
 */
const RISK_INPUTS: Array<{
  asset: string; likelihood: number; impact: number; exposure: number; controlGap: number;
}> = [
  { asset: "billing",   likelihood: 5, impact: 5, exposure: 5, controlGap: 5 }, // 100.00 EXTREME
  { asset: "insurance", likelihood: 4, impact: 5, exposure: 5, controlGap: 5 }, //  80.00 CRITICAL
  { asset: "ehr",       likelihood: 5, impact: 4, exposure: 5, controlGap: 3 }, //  48.00 HIGH
  { asset: "imaging",   likelihood: 4, impact: 4, exposure: 5, controlGap: 3 }, //  38.40 MODERATE
  { asset: "analytics", likelihood: 3, impact: 5, exposure: 4, controlGap: 3 }, //  28.80 MODERATE
  { asset: "lab",       likelihood: 3, impact: 4, exposure: 4, controlGap: 3 }, //  23.04 MODERATE
  { asset: "pharmacy",  likelihood: 2, impact: 4, exposure: 3, controlGap: 3 }, //  11.52 LOW
  { asset: "portal",    likelihood: 3, impact: 3, exposure: 3, controlGap: 2 }, //   8.64 LOW
];

/**
 * Demo accounts. All three share one password, taken from DEMO_USER_PASSWORD
 * so the credential is never committed. They exist to exercise the three
 * roles; there is no signup or invite flow yet.
 */
const USERS: Array<{ email: string; role: "ADMIN" | "ANALYST" | "VIEWER" }> = [
  { email: "admin@meridian.org", role: "ADMIN" },
  { email: "f.alrashid@meridian.org", role: "ANALYST" },
  { email: "a.patel@meridian.org", role: "VIEWER" },
];

/**
 * Vendors, spread deliberately across BAA and assessment states so the module
 * has something to show. The two worst cases are the point of the demo: a
 * vendor with PHI access and no BAA at all, and one whose BAA has expired.
 */
const VENDORS: Array<{
  key: string; name: string; baaStatus: BaaStatus; phiVolume: number;
  daysSinceAssessment: number | null; assets: string[];
  likelihood: number; impact: number; exposure: number; controlGap: number;
}> = [
  {
    key: "claims", name: "Northwind Claims Processing", baaStatus: "MISSING",
    phiVolume: 71_300, daysSinceAssessment: null, assets: ["billing", "insurance"],
    likelihood: 5, impact: 5, exposure: 5, controlGap: 5, // 100.00 EXTREME
  },
  {
    key: "transcribe", name: "Veritas Transcription", baaStatus: "EXPIRED",
    phiVolume: 44_800, daysSinceAssessment: 512, assets: ["ehr"],
    likelihood: 4, impact: 5, exposure: 5, controlGap: 5, // 80.00 CRITICAL
  },
  {
    key: "imaging", name: "Clarity Imaging Partners", baaStatus: "PENDING",
    phiVolume: 51_200, daysSinceAssessment: 240, assets: ["imaging", "lab"],
    likelihood: 4, impact: 4, exposure: 5, controlGap: 3, // 38.40 MODERATE
  },
  {
    key: "analytics", name: "Helix Population Analytics", baaStatus: "SIGNED",
    phiVolume: 229_000, daysSinceAssessment: 95, assets: ["analytics"],
    likelihood: 3, impact: 5, exposure: 4, controlGap: 3, // 28.80 MODERATE
  },
  {
    key: "backup", name: "Sentinel Backup Services", baaStatus: "SIGNED",
    phiVolume: 12_400, daysSinceAssessment: 30, assets: ["portal"],
    likelihood: 2, impact: 4, exposure: 3, controlGap: 3, // 11.52 LOW
  },
];

/**
 * Identities and their access. Deliberately includes the findings an access
 * review exists to surface:
 *  - a departed contractor whose admin grant is still live and unused for 8
 *    months (inactive identity + stale + excessive level: four flags)
 *  - a legacy service account nobody has ever seen use
 *  - a billing analyst with write access to the EHR and no MFA
 */
const IDENTITIES: Array<{
  key: string; displayName: string; email: string | null; kind: IdentityKind;
  department: string | null; role: "ADMIN" | "ANALYST" | "VIEWER";
  active: boolean; mfaEnabled: boolean;
}> = [
  { key: "patel", displayName: "Dr. Aisha Patel", email: "a.patel@meridian.org", kind: "USER", department: "ICU", role: "VIEWER", active: true, mfaEnabled: true },
  { key: "thompson", displayName: "Marcus Thompson", email: "m.thompson@meridian.org", kind: "USER", department: "IT Infrastructure", role: "ADMIN", active: true, mfaEnabled: true },
  { key: "santos", displayName: "Maria Santos", email: "m.santos@meridian.org", kind: "USER", department: "Billing", role: "ANALYST", active: true, mfaEnabled: false },
  { key: "chen", displayName: "Robert Chen (contractor)", email: "r.chen@contractor.example", kind: "USER", department: "Radiology", role: "ANALYST", active: false, mfaEnabled: false },
  { key: "etl", displayName: "svc-analytics-etl", email: null, kind: "SERVICE_ACCOUNT", department: "Data Platform", role: "ANALYST", active: true, mfaEnabled: false },
  { key: "legacy", displayName: "svc-legacy-billing-sync", email: null, kind: "SERVICE_ACCOUNT", department: "Billing", role: "ANALYST", active: true, mfaEnabled: false },
];

const GRANTS: Array<{
  identity: string; asset: string; level: AccessLevel;
  grantedDaysAgo: number; usedDaysAgo: number | null;
}> = [
  { identity: "patel", asset: "ehr", level: "READ", grantedDaysAgo: 420, usedDaysAgo: 1 },
  { identity: "thompson", asset: "ehr", level: "ADMIN", grantedDaysAgo: 800, usedDaysAgo: 2 },
  { identity: "thompson", asset: "analytics", level: "ADMIN", grantedDaysAgo: 300, usedDaysAgo: 5 },
  { identity: "santos", asset: "billing", level: "WRITE", grantedDaysAgo: 600, usedDaysAgo: 1 },
  // No MFA, write access to a 412k-record EHR.
  { identity: "santos", asset: "ehr", level: "WRITE", grantedDaysAgo: 240, usedDaysAgo: 3 },
  // The headline finding: departed contractor, admin rights, unused 8 months.
  { identity: "chen", asset: "imaging", level: "ADMIN", grantedDaysAgo: 500, usedDaysAgo: 243 },
  { identity: "etl", asset: "analytics", level: "READ", grantedDaysAgo: 200, usedDaysAgo: 1 },
  { identity: "etl", asset: "lab", level: "READ", grantedDaysAgo: 200, usedDaysAgo: 2 },
  // Provisioned and forgotten: never once used.
  { identity: "legacy", asset: "billing", level: "WRITE", grantedDaysAgo: 910, usedDaysAgo: null },
];

/**
 * Threats, spread across severity and status so the feed shows a realistic
 * mix rather than a wall of criticals. Each one points at an asset whose
 * seeded weaknesses make it plausible: the bulk export is on the
 * unencrypted billing database, the Tor login on the externally reachable
 * claims gateway.
 */
const THREATS: Array<{
  asset: string; severity: ThreatSeverity; status: ThreatStatus;
  title: string; description: string; hoursAgo: number; resolvedHoursAgo: number | null;
}> = [
  {
    asset: "billing", severity: "CRITICAL", status: "INVESTIGATING",
    title: "Bulk PHI export from billing database",
    description: "847 patient records exported to an unmanaged endpoint in a single session, well outside the normal daily pattern for this account.",
    hoursAgo: 4, resolvedHoursAgo: null,
  },
  {
    asset: "insurance", severity: "CRITICAL", status: "OPEN",
    title: "Authenticated session from Tor exit node",
    description: "Claims gateway accepted credentials from 185.220.101.45, a known Tor exit node. The gateway is internet-facing and unencrypted in transit.",
    hoursAgo: 9, resolvedHoursAgo: null,
  },
  {
    asset: "ehr", severity: "HIGH", status: "OPEN",
    title: "Privilege escalation attempt on EHR core",
    description: "An analyst-level account issued three consecutive admin-scoped API calls, all rejected. No successful escalation observed.",
    hoursAgo: 26, resolvedHoursAgo: null,
  },
  {
    asset: "imaging", severity: "MEDIUM", status: "RESOLVED",
    title: "Imaging archive accessed outside working hours",
    description: "Radiology PACS read at 02:14 from a new device. Confirmed as on-call review; device has since been enrolled.",
    hoursAgo: 52, resolvedHoursAgo: 30,
  },
  {
    asset: "analytics", severity: "LOW", status: "FALSE_POSITIVE",
    title: "Anomalous query volume against analytics lake",
    description: "Detector flagged a 6x spike in query volume. Traced to a scheduled quarterly reporting job; detector threshold has been retuned.",
    hoursAgo: 96, resolvedHoursAgo: 80,
  },
];


/**
 * Controls. Eight safeguards spanning every category, deliberately mixed in
 * maturity so the control register shows real variation rather than a wall of
 * green: two are effective, several partial, one planned and one not
 * implemented at all.
 *
 * `frameworkRef` is a customer-style reference string. It is stored as a
 * pointer and asserts no conformance -- see the Control model comment.
 */
const CONTROLS: Array<{
  key: string; name: string; description: string;
  category: "ACCESS" | "ENCRYPTION" | "MONITORING" | "GOVERNANCE" | "RESILIENCE" | "VENDOR";
  status: "IMPLEMENTED" | "PARTIAL" | "PLANNED" | "NOT_IMPLEMENTED";
  effectiveness: "EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "INEFFECTIVE" | "NOT_ASSESSED";
  owner: string; frameworkRef: string; reviewedDaysAgo: number | null;
  assets: string[];
}> = [
  {
    key: "mfa", name: "Multi-Factor Authentication",
    description: "MFA required for all interactive access to systems holding PHI.",
    category: "ACCESS", status: "PARTIAL", effectiveness: "PARTIALLY_EFFECTIVE",
    owner: "Marcus Thompson", frameworkRef: "HIPAA 164.312(d)", reviewedDaysAgo: 45,
    assets: ["portal", "pharmacy", "ehr", "lab"],
  },
  {
    key: "encryption-rest", name: "Encryption at Rest",
    description: "AES-256 encryption for all stored PHI, with keys held in a managed KMS.",
    category: "ENCRYPTION", status: "IMPLEMENTED", effectiveness: "EFFECTIVE",
    owner: "Marcus Thompson", frameworkRef: "HIPAA 164.312(a)(2)(iv)", reviewedDaysAgo: 30,
    assets: ["portal", "pharmacy", "ehr", "lab", "imaging", "analytics"],
  },
  {
    key: "encryption-transit", name: "Encryption in Transit",
    description: "TLS 1.2+ enforced on every interface carrying PHI between systems.",
    category: "ENCRYPTION", status: "PARTIAL", effectiveness: "PARTIALLY_EFFECTIVE",
    owner: "Marcus Thompson", frameworkRef: "HIPAA 164.312(e)(1)", reviewedDaysAgo: 30,
    assets: ["ehr", "lab", "imaging"],
  },
  {
    key: "least-privilege", name: "Least Privilege Access",
    description: "Access granted at the lowest level required, reviewed on role change.",
    category: "ACCESS", status: "PARTIAL", effectiveness: "INEFFECTIVE",
    owner: "Fatima Al-Rashid", frameworkRef: "HIPAA 164.308(a)(4)", reviewedDaysAgo: 120,
    assets: ["billing", "insurance", "imaging"],
  },
  {
    key: "access-review", name: "Quarterly Access Review",
    description: "Every access grant reviewed and attested at least once per quarter.",
    category: "GOVERNANCE", status: "PLANNED", effectiveness: "NOT_ASSESSED",
    owner: "Fatima Al-Rashid", frameworkRef: "HIPAA 164.308(a)(3)(ii)(B)", reviewedDaysAgo: null,
    assets: [],
  },
  {
    key: "vendor-baa", name: "Vendor BAA Management",
    description: "A signed Business Associate Agreement before any vendor touches PHI.",
    category: "VENDOR", status: "PARTIAL", effectiveness: "INEFFECTIVE",
    owner: "Fatima Al-Rashid", frameworkRef: "HIPAA 164.308(b)(1)", reviewedDaysAgo: 90,
    assets: ["billing", "insurance", "imaging"],
  },
  {
    key: "audit-logging", name: "Access Audit Logging",
    description: "All PHI access logged with actor, timestamp and source address.",
    category: "MONITORING", status: "IMPLEMENTED", effectiveness: "EFFECTIVE",
    owner: "Marcus Thompson", frameworkRef: "HIPAA 164.312(b)", reviewedDaysAgo: 15,
    assets: ["ehr", "billing", "insurance"],
  },
  {
    key: "backup", name: "Encrypted Backup and Recovery",
    description: "Daily encrypted backups with a tested quarterly restore.",
    category: "RESILIENCE", status: "NOT_IMPLEMENTED", effectiveness: "NOT_ASSESSED",
    owner: "Marcus Thompson", frameworkRef: "HIPAA 164.308(a)(7)", reviewedDaysAgo: null,
    assets: [],
  },
];

/** A small policy register, each backed by the controls that implement it. */
const POLICIES: Array<{
  name: string; description: string;
  status: "DRAFT" | "ACTIVE" | "UNDER_REVIEW" | "ARCHIVED";
  owner: string; evidenceRef: string | null; reviewDueInDays: number | null;
  controls: string[];
}> = [
  {
    name: "Information Access Management Policy",
    description: "How access to systems holding PHI is requested, approved, reviewed and revoked.",
    status: "ACTIVE", owner: "Fatima Al-Rashid",
    evidenceRef: "policies/iam-v3.pdf", reviewDueInDays: 45,
    controls: ["mfa", "least-privilege", "access-review"],
  },
  {
    name: "Data Encryption Policy",
    description: "Required encryption for PHI at rest and in transit, and key management.",
    status: "ACTIVE", owner: "Marcus Thompson",
    evidenceRef: "policies/encryption-v2.pdf", reviewDueInDays: 120,
    controls: ["encryption-rest", "encryption-transit"],
  },
  {
    name: "Third-Party Risk Management Policy",
    description: "Due diligence, BAA execution and reassessment cadence for vendors touching PHI.",
    status: "UNDER_REVIEW", owner: "Fatima Al-Rashid",
    evidenceRef: null, reviewDueInDays: -14,
    controls: ["vendor-baa"],
  },
  {
    name: "Audit Controls Policy",
    description: "What is logged, how long it is retained and who may read it.",
    status: "DRAFT", owner: "Marcus Thompson",
    evidenceRef: null, reviewDueInDays: null,
    controls: ["audit-logging"],
  },
];

/**
 * Remediation, spanning every state a demonstration needs to show: an open
 * critical finding, work in progress, something resolved, and a risk formally
 * accepted rather than fixed.
 *
 * Each links to the record that surfaced it, so the finding can be traced back
 * to its evidence rather than floating free.
 */
const REMEDIATIONS: Array<{
  title: string; description: string; recommendation: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "ACCEPTED" | "REOPENED";
  source: "RISK" | "THREAT" | "ACCESS" | "VENDOR" | "CONTROL" | "MANUAL";
  ownerEmail: string | null; dueInDays: number | null; resolvedDaysAgo: number | null;
  asset?: string; vendorName?: string; threatTitle?: string; controlKey?: string;
}> = [
  {
    title: "Billing Engine DB stores PHI unencrypted",
    description:
      "Billing Engine DB holds 87,100 PHI records with at-rest encryption disabled, and is the target of an unencrypted flow from Epic EHR Core.",
    recommendation:
      "Enable AES-256 at-rest encryption on the billing database and re-key the existing volume during the next maintenance window.",
    severity: "CRITICAL", status: "OPEN", source: "RISK",
    ownerEmail: "admin@meridian.org", dueInDays: 14, resolvedDaysAgo: null,
    asset: "billing",
  },
  {
    title: "Northwind Claims Processing has no signed BAA",
    description:
      "Northwind Claims Processing can reach two systems holding PHI and has never returned a signed Business Associate Agreement.",
    recommendation:
      "Suspend the vendor's access until a BAA is executed, or complete execution before the next claims cycle.",
    severity: "CRITICAL", status: "IN_PROGRESS", source: "VENDOR",
    ownerEmail: "f.alrashid@meridian.org", dueInDays: 7, resolvedDaysAgo: null,
    vendorName: "Northwind Claims Processing",
  },
  {
    title: "Contractor retains ADMIN access to Imaging Archive",
    description:
      "A deactivated contractor identity still holds ADMIN access to Imaging Archive (S3), last exercised over eight months ago.",
    recommendation: "Revoke the grant and confirm no automation depends on the credential.",
    severity: "HIGH", status: "OPEN", source: "ACCESS",
    ownerEmail: "f.alrashid@meridian.org", dueInDays: 3, resolvedDaysAgo: null,
    asset: "imaging",
  },
  {
    title: "Tor exit node reached the claims gateway",
    description:
      "Insurance Claims Gateway accepted an authenticated session from a known Tor exit node. The gateway is internet-facing and unencrypted in transit.",
    recommendation:
      "Terminate the session, rotate the credential involved and place the gateway behind the IP allowlist.",
    severity: "CRITICAL", status: "OPEN", source: "THREAT",
    ownerEmail: "admin@meridian.org", dueInDays: 1, resolvedDaysAgo: null,
    threatTitle: "Authenticated session from Tor exit node",
  },
  {
    title: "MFA not enforced on Clinical Analytics Lake",
    description:
      "Clinical Analytics Lake holds 229,000 PHI records and does not require MFA for interactive access.",
    recommendation: "Extend the MFA control to the analytics estate and verify coverage.",
    severity: "HIGH", status: "RESOLVED", source: "CONTROL",
    ownerEmail: "admin@meridian.org", dueInDays: null, resolvedDaysAgo: 5,
    controlKey: "mfa",
  },
  {
    title: "Legacy billing sync service account has never been used",
    description:
      "svc-legacy-billing-sync holds WRITE access to Billing Engine DB and has no recorded use since it was granted.",
    recommendation:
      "Retire the service account, or document the dependency that requires it to remain.",
    severity: "MEDIUM", status: "ACCEPTED", source: "ACCESS",
    ownerEmail: "f.alrashid@meridian.org", dueInDays: null, resolvedDaysAgo: 2,
    asset: "billing",
  },
];

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

async function main() {
  // Idempotent, and RESTART IDENTITY keeps primary keys stable across
  // reseeds -- deleteMany() would leave the sequences advanced, so every
  // reseed would shift every id and break any link the frontend had saved.
  // Idempotent, and RESTART IDENTITY keeps primary keys stable across reseeds.
  //
  // Organization is deliberately NOT truncated. It is created by the platform
  // migration and everything else hangs off it; dropping and recreating it on
  // every reseed would renumber the tenant and orphan any saved link. It is
  // upserted below instead.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditEvent", "RiskHistory", "Remediation", "PolicyControl", "Policy", ' +
      '"AssetControl", "Control", "RefreshToken", "Threat", "AccessGrant", "Identity", ' +
      '"VendorRisk", "VendorAssetAccess", "Vendor", "Risk", "DataFlow", "AssetPHI", ' +
      '"Asset", "PHIType", "OrganizationMember", "User" RESTART IDENTITY CASCADE',
  );

  // The founding organisation. Upserted so a reseed reuses the same id.
  const org = await prisma.organization.upsert({
    where: { slug: "meridian" },
    update: {},
    create: { name: "Meridian Health System", slug: "meridian" },
  });
  const organizationId = org.id;

  const assetIds = new Map<string, number>();
  for (const a of ASSETS) {
    const created = await prisma.asset.create({
      data: {
        organizationId,
        name: a.name,
        type: a.type,
        phiVolume: a.phiVolume,
        encrypted: a.encrypted,
        mfaEnabled: a.mfaEnabled,
        lastAssessedAt: a.daysSinceAssessment === null ? null : daysAgo(a.daysSinceAssessment),
      },
    });
    assetIds.set(a.key, created.id);
  }

  const phiTypeIds = new Map<string, number>();
  for (const p of PHI_TYPES) {
    const created = await prisma.pHIType.create({
      data: { organizationId, name: p.name, sensitivity: p.sensitivity },
    });
    phiTypeIds.set(p.key, created.id);
  }

  const assetId = (key: string) => {
    const id = assetIds.get(key);
    if (id === undefined) throw new Error(`Unknown asset key in seed: ${key}`);
    return id;
  };
  const phiTypeId = (key: string) => {
    const id = phiTypeIds.get(key);
    if (id === undefined) throw new Error(`Unknown PHI type key in seed: ${key}`);
    return id;
  };

  await prisma.assetPHI.createMany({
    data: ASSET_PHI.map((link) => ({
      assetId: assetId(link.asset),
      phiTypeId: phiTypeId(link.phiType),
      recordsPerDay: link.recordsPerDay,
    })),
  });

  await prisma.dataFlow.createMany({
    data: FLOWS.map((f) => ({
      organizationId,
      sourceAssetId: assetId(f.source),
      targetAssetId: assetId(f.target),
      phiTypeId: phiTypeId(f.phiType),
      recordsPerDay: f.recordsPerDay,
      encrypted: f.encrypted,
    })),
  });

  await prisma.risk.createMany({
    data: RISK_INPUTS.map((r) => {
      const { score, band } = computeRisk(r.likelihood, r.impact, r.exposure, r.controlGap);
      return {
        organizationId,
        assetId: assetId(r.asset),
        likelihood: r.likelihood,
        impact: r.impact,
        exposure: r.exposure,
        controlGap: r.controlGap,
        score,
        band,
      };
    }),
  });

  const demoPassword = process.env.DEMO_USER_PASSWORD;
  if (!demoPassword) {
    throw new Error("DEMO_USER_PASSWORD is not set — see .env.example");
  }
  const passwordHash = await hashPassword(demoPassword);
  await prisma.user.createMany({
    data: USERS.map((u) => ({ ...u, passwordHash })),
  });

  // Membership is what actually governs authorisation; User.role is only the
  // account default. Seeded with the same role so the two agree.
  const seededUsers = await prisma.user.findMany({ select: { id: true, role: true } });
  await prisma.organizationMember.createMany({
    data: seededUsers.map((u) => ({ userId: u.id, organizationId, role: u.role })),
  });

  for (const v of VENDORS) {
    const vendor = await prisma.vendor.create({
      data: {
        organizationId,
        name: v.name,
        baaStatus: v.baaStatus,
        phiVolume: v.phiVolume,
        lastAssessedAt: v.daysSinceAssessment === null ? null : daysAgo(v.daysSinceAssessment),
      },
    });

    await prisma.vendorAssetAccess.createMany({
      data: v.assets.map((key) => ({ vendorId: vendor.id, assetId: assetId(key) })),
    });

    const { score, band } = computeRisk(v.likelihood, v.impact, v.exposure, v.controlGap);
    await prisma.vendorRisk.create({
      data: {
        organizationId,
        vendorId: vendor.id,
        likelihood: v.likelihood, impact: v.impact,
        exposure: v.exposure, controlGap: v.controlGap,
        score, band,
      },
    });
  }

  const identityIds = new Map<string, number>();
  for (const i of IDENTITIES) {
    const created = await prisma.identity.create({
      data: {
        organizationId,
        displayName: i.displayName, email: i.email, kind: i.kind,
        department: i.department, role: i.role, active: i.active, mfaEnabled: i.mfaEnabled,
      },
    });
    identityIds.set(i.key, created.id);
  }

  await prisma.accessGrant.createMany({
    data: GRANTS.map((g) => {
      const identityId = identityIds.get(g.identity);
      if (identityId === undefined) throw new Error(`Unknown identity key: ${g.identity}`);
      return {
        organizationId,
        identityId,
        assetId: assetId(g.asset),
        level: g.level,
        grantedAt: daysAgo(g.grantedDaysAgo),
        lastUsedAt: g.usedDaysAgo === null ? null : daysAgo(g.usedDaysAgo),
      };
    }),
  });

  await prisma.threat.createMany({
    data: THREATS.map((t) => ({
      organizationId,
      assetId: assetId(t.asset),
      severity: t.severity,
      status: t.status,
      title: t.title,
      description: t.description,
      detectedAt: hoursAgo(t.hoursAgo),
      resolvedAt: t.resolvedHoursAgo === null ? null : hoursAgo(t.resolvedHoursAgo),
    })),
  });


  // ---------------------------------------------------------------- controls
  const controlIds = new Map<string, number>();
  for (const c of CONTROLS) {
    const created = await prisma.control.create({
      data: {
        organizationId,
        name: c.name, description: c.description, category: c.category,
        status: c.status, effectiveness: c.effectiveness,
        owner: c.owner, frameworkRef: c.frameworkRef,
        lastReviewedAt: c.reviewedDaysAgo === null ? null : daysAgo(c.reviewedDaysAgo),
      },
    });
    controlIds.set(c.key, created.id);

    if (c.assets.length > 0) {
      await prisma.assetControl.createMany({
        data: c.assets.map((key) => ({ assetId: assetId(key), controlId: created.id })),
      });
    }
  }

  const controlId = (key: string) => {
    const id = controlIds.get(key);
    if (id === undefined) throw new Error(`Unknown control key in seed: ${key}`);
    return id;
  };

  // ---------------------------------------------------------------- policies
  for (const p of POLICIES) {
    const created = await prisma.policy.create({
      data: {
        organizationId,
        name: p.name, description: p.description, status: p.status,
        owner: p.owner, evidenceRef: p.evidenceRef,
        reviewDueAt: p.reviewDueInDays === null ? null : daysAgo(-p.reviewDueInDays),
      },
    });
    await prisma.policyControl.createMany({
      data: p.controls.map((key) => ({ policyId: created.id, controlId: controlId(key) })),
    });
  }

  // ------------------------------------------------------------- remediation
  const userByEmail = new Map(
    (await prisma.user.findMany({ select: { id: true, email: true } })).map((u) => [u.email, u.id]),
  );
  const vendorByName = new Map(
    (await prisma.vendor.findMany({ select: { id: true, name: true } })).map((v) => [v.name, v.id]),
  );
  const threatByTitle = new Map(
    (await prisma.threat.findMany({ select: { id: true, title: true } })).map((t) => [t.title, t.id]),
  );

  for (const r of REMEDIATIONS) {
    await prisma.remediation.create({
      data: {
        organizationId,
        title: r.title, description: r.description, recommendation: r.recommendation,
        severity: r.severity, status: r.status, source: r.source,
        ownerId: r.ownerEmail ? userByEmail.get(r.ownerEmail) ?? null : null,
        dueAt: r.dueInDays === null ? null : daysAgo(-r.dueInDays),
        resolvedAt: r.resolvedDaysAgo === null ? null : daysAgo(r.resolvedDaysAgo),
        assetId: r.asset ? assetId(r.asset) : null,
        vendorId: r.vendorName ? vendorByName.get(r.vendorName) ?? null : null,
        threatId: r.threatTitle ? threatByTitle.get(r.threatTitle) ?? null : null,
        controlId: r.controlKey ? controlId(r.controlKey) : null,
      },
    });
  }

  // ------------------------------------------------------------ risk history
  //
  // One history row per seeded assessment, so a fresh database still has a
  // trail rather than an empty History tab. previousScore is null because
  // these *are* the first assessments -- inventing an earlier score to make
  // the chart look busier would be fabricating data.
  const seededRisks = await prisma.risk.findMany();
  await prisma.riskHistory.createMany({
    data: seededRisks.map((risk) => ({
      organizationId,
      riskId: risk.id,
      assetId: risk.assetId,
      previousScore: null,
      previousBand: null,
      score: risk.score,
      band: risk.band,
      likelihood: risk.likelihood,
      impact: risk.impact,
      exposure: risk.exposure,
      controlGap: risk.controlGap,
      reason: "INITIAL_ASSESSMENT" as const,
      changedById: null,
    })),
  });

  const [assets, phiTypes, links, flows, risks, users, vendors, vendorAccess, vendorRisks] =
    await Promise.all([
      prisma.asset.count(),
      prisma.pHIType.count(),
      prisma.assetPHI.count(),
      prisma.dataFlow.count(),
      prisma.risk.count(),
      prisma.user.count(),
      prisma.vendor.count(),
      prisma.vendorAssetAccess.count(),
      prisma.vendorRisk.count(),
    ]);
  const [identities, grants, threats] = await Promise.all([
    prisma.identity.count(),
    prisma.accessGrant.count(),
    prisma.threat.count(),
  ]);

  console.log(
    `[seed] assets=${assets} phiTypes=${phiTypes} assetPHI=${links} dataFlows=${flows} ` +
      `risks=${risks} users=${users} vendors=${vendors} vendorAccess=${vendorAccess} ` +
      `vendorRisks=${vendorRisks} identities=${identities} accessGrants=${grants} ` +
      `threats=${threats}`,
  );
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
