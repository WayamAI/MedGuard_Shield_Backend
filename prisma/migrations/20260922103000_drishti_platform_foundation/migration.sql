-- Drishti platform foundation.
--
-- Hand-authored from `prisma migrate diff` output, restructured so it is safe
-- against a populated database. `prisma migrate dev` generates
-- `organizationId INTEGER NOT NULL` with no default, which cannot execute on a
-- table that already has rows; every tenant column below is therefore added
-- nullable, backfilled to the founding organisation, and only then made NOT
-- NULL. Nothing is dropped and no row is deleted.

-- ============================================================ enums

CREATE TYPE "ControlCategory" AS ENUM ('ACCESS', 'ENCRYPTION', 'MONITORING', 'GOVERNANCE', 'RESILIENCE', 'VENDOR');

CREATE TYPE "ControlStatus" AS ENUM ('IMPLEMENTED', 'PARTIAL', 'PLANNED', 'NOT_IMPLEMENTED');

CREATE TYPE "ControlEffectiveness" AS ENUM ('EFFECTIVE', 'PARTIALLY_EFFECTIVE', 'INEFFECTIVE', 'NOT_ASSESSED');

CREATE TYPE "RemediationStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'ACCEPTED', 'REOPENED');

CREATE TYPE "RemediationSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TYPE "FindingSource" AS ENUM ('RISK', 'THREAT', 'ACCESS', 'VENDOR', 'CONTROL', 'MANUAL');

CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'UNDER_REVIEW', 'ARCHIVED');

CREATE TYPE "RiskChangeReason" AS ENUM ('INITIAL_ASSESSMENT', 'MANUAL_ASSESSMENT', 'RECOMPUTE', 'IMPORTED');

CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'TOKEN_REFRESHED', 'TOKEN_REVOKED', 'ASSET_CREATED', 'ASSET_UPDATED', 'ASSET_ARCHIVED', 'ASSET_RESTORED', 'RISK_CREATED', 'RISK_UPDATED', 'RISK_RECOMPUTED', 'VENDOR_CREATED', 'VENDOR_UPDATED', 'VENDOR_ARCHIVED', 'VENDOR_RESTORED', 'IDENTITY_CREATED', 'IDENTITY_UPDATED', 'IDENTITY_ARCHIVED', 'ACCESS_GRANTED', 'ACCESS_UPDATED', 'ACCESS_REVOKED', 'ACCESS_REVIEWED', 'THREAT_CREATED', 'THREAT_UPDATED', 'THREAT_STATUS_CHANGED', 'CONTROL_CREATED', 'CONTROL_UPDATED', 'CONTROL_ARCHIVED', 'CONTROL_LINKED_ASSET', 'CONTROL_UNLINKED_ASSET', 'POLICY_CREATED', 'POLICY_UPDATED', 'POLICY_ARCHIVED', 'REMEDIATION_CREATED', 'REMEDIATION_UPDATED', 'REMEDIATION_ASSIGNED', 'REMEDIATION_RESOLVED', 'REMEDIATION_REOPENED', 'IMPORT_STARTED', 'IMPORT_COMPLETED', 'IMPORT_FAILED');

CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'FAILURE');

-- ============================================================ tenancy tables

CREATE TABLE "Organization" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrganizationMember" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (needed before the backfill can look the organisation up by slug)
CREATE UNIQUE INDEX "Organization_name_key" ON "Organization"("name");
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- ============================================================ founding organisation
--
-- Every pre-existing row belongs to the single organisation this deployment
-- has always implicitly been. Created here rather than in the seed so that
-- the backfill below has something to point at on any database, seeded or not.

INSERT INTO "Organization" ("name", "slug", "createdAt", "updatedAt")
SELECT 'Meridian Health System', 'meridian', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Organization" WHERE "slug" = 'meridian');

-- Existing accounts become members of it, carrying the role they already had.
INSERT INTO "OrganizationMember" ("userId", "organizationId", "role", "createdAt", "updatedAt")
SELECT u."id", (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian'), u."role", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "User" u;

-- ============================================================ drop superseded indexes

DROP INDEX "Asset_name_key";
DROP INDEX "Identity_email_key";
DROP INDEX "PHIType_name_key";
DROP INDEX "Risk_assetId_idx";
DROP INDEX "Vendor_name_key";
DROP INDEX "VendorRisk_vendorId_idx";

-- ============================================================ alter existing tables

ALTER TABLE "AccessGrant" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastReviewedAt" TIMESTAMP(3),
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Asset" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AssetPHI" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DataFlow" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Identity" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "PHIType" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Risk" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Threat" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "User" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Vendor" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "VendorRisk" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ============================================================ backfill tenant scope

UPDATE "AccessGrant" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "Asset" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "DataFlow" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "Identity" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "PHIType" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "Risk" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "Threat" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "Vendor" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;
UPDATE "VendorRisk" SET "organizationId" = (SELECT "id" FROM "Organization" WHERE "slug" = 'meridian') WHERE "organizationId" IS NULL;

ALTER TABLE "AccessGrant" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Asset" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "DataFlow" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Identity" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "PHIType" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Risk" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Threat" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Vendor" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "VendorRisk" ALTER COLUMN "organizationId" SET NOT NULL;

-- ============================================================ new tables

CREATE TABLE "RefreshToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "replacedByTokenHash" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiskHistory" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "riskId" INTEGER,
    "assetId" INTEGER NOT NULL,
    "previousScore" DOUBLE PRECISION,
    "previousBand" "RiskBand",
    "score" DOUBLE PRECISION NOT NULL,
    "band" "RiskBand" NOT NULL,
    "likelihood" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "exposure" INTEGER NOT NULL,
    "controlGap" INTEGER NOT NULL,
    "reason" "RiskChangeReason" NOT NULL,
    "changedById" INTEGER,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Control" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ControlCategory" NOT NULL,
    "status" "ControlStatus" NOT NULL DEFAULT 'NOT_IMPLEMENTED',
    "effectiveness" "ControlEffectiveness" NOT NULL DEFAULT 'NOT_ASSESSED',
    "owner" TEXT,
    "frameworkRef" TEXT,
    "lastReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Control_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssetControl" (
    "assetId" INTEGER NOT NULL,
    "controlId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetControl_pkey" PRIMARY KEY ("assetId","controlId")
);

CREATE TABLE "Policy" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "owner" TEXT,
    "evidenceRef" TEXT,
    "reviewDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyControl" (
    "policyId" INTEGER NOT NULL,
    "controlId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyControl_pkey" PRIMARY KEY ("policyId","controlId")
);

CREATE TABLE "Remediation" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "severity" "RemediationSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "RemediationStatus" NOT NULL DEFAULT 'OPEN',
    "source" "FindingSource" NOT NULL DEFAULT 'MANUAL',
    "ownerId" INTEGER,
    "dueAt" TIMESTAMP(3),
    "assetId" INTEGER,
    "vendorId" INTEGER,
    "threatId" INTEGER,
    "controlId" INTEGER,
    "identityId" INTEGER,
    "accessGrantId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Remediation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER,
    "actorUserId" INTEGER,
    "actorEmail" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT,
    "entityId" INTEGER,
    "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS',
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- ============================================================ indexes

CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");
CREATE INDEX "OrganizationMember_organizationId_idx" ON "OrganizationMember"("organizationId");
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");
CREATE UNIQUE INDEX "OrganizationMember_userId_organizationId_key" ON "OrganizationMember"("userId", "organizationId");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE INDEX "RefreshToken_revokedAt_idx" ON "RefreshToken"("revokedAt");
CREATE INDEX "RiskHistory_organizationId_idx" ON "RiskHistory"("organizationId");
CREATE INDEX "RiskHistory_assetId_changedAt_idx" ON "RiskHistory"("assetId", "changedAt");
CREATE INDEX "RiskHistory_changedAt_idx" ON "RiskHistory"("changedAt");
CREATE INDEX "Control_organizationId_idx" ON "Control"("organizationId");
CREATE INDEX "Control_category_idx" ON "Control"("category");
CREATE INDEX "Control_status_idx" ON "Control"("status");
CREATE INDEX "Control_archivedAt_idx" ON "Control"("archivedAt");
CREATE UNIQUE INDEX "Control_organizationId_name_key" ON "Control"("organizationId", "name");
CREATE INDEX "AssetControl_controlId_idx" ON "AssetControl"("controlId");
CREATE INDEX "Policy_organizationId_idx" ON "Policy"("organizationId");
CREATE INDEX "Policy_status_idx" ON "Policy"("status");
CREATE INDEX "Policy_archivedAt_idx" ON "Policy"("archivedAt");
CREATE UNIQUE INDEX "Policy_organizationId_name_key" ON "Policy"("organizationId", "name");
CREATE INDEX "PolicyControl_controlId_idx" ON "PolicyControl"("controlId");
CREATE INDEX "Remediation_organizationId_idx" ON "Remediation"("organizationId");
CREATE INDEX "Remediation_status_idx" ON "Remediation"("status");
CREATE INDEX "Remediation_severity_idx" ON "Remediation"("severity");
CREATE INDEX "Remediation_ownerId_idx" ON "Remediation"("ownerId");
CREATE INDEX "Remediation_dueAt_idx" ON "Remediation"("dueAt");
CREATE INDEX "Remediation_assetId_idx" ON "Remediation"("assetId");
CREATE INDEX "Remediation_vendorId_idx" ON "Remediation"("vendorId");
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");
CREATE INDEX "AuditEvent_actorUserId_idx" ON "AuditEvent"("actorUserId");
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
CREATE INDEX "AccessGrant_organizationId_idx" ON "AccessGrant"("organizationId");
CREATE INDEX "AccessGrant_revokedAt_idx" ON "AccessGrant"("revokedAt");
CREATE INDEX "Asset_organizationId_idx" ON "Asset"("organizationId");
CREATE INDEX "Asset_archivedAt_idx" ON "Asset"("archivedAt");
CREATE UNIQUE INDEX "Asset_organizationId_name_key" ON "Asset"("organizationId", "name");
CREATE INDEX "DataFlow_organizationId_idx" ON "DataFlow"("organizationId");
CREATE UNIQUE INDEX "DataFlow_sourceAssetId_targetAssetId_phiTypeId_key" ON "DataFlow"("sourceAssetId", "targetAssetId", "phiTypeId");
CREATE INDEX "Identity_organizationId_idx" ON "Identity"("organizationId");
CREATE INDEX "Identity_archivedAt_idx" ON "Identity"("archivedAt");
CREATE UNIQUE INDEX "Identity_organizationId_displayName_key" ON "Identity"("organizationId", "displayName");
CREATE UNIQUE INDEX "Identity_organizationId_email_key" ON "Identity"("organizationId", "email");
CREATE INDEX "PHIType_organizationId_idx" ON "PHIType"("organizationId");
CREATE UNIQUE INDEX "PHIType_organizationId_name_key" ON "PHIType"("organizationId", "name");
CREATE INDEX "Risk_organizationId_idx" ON "Risk"("organizationId");
CREATE UNIQUE INDEX "Risk_assetId_key" ON "Risk"("assetId");
CREATE INDEX "Threat_organizationId_idx" ON "Threat"("organizationId");
CREATE UNIQUE INDEX "Threat_assetId_title_key" ON "Threat"("assetId", "title");
CREATE INDEX "Vendor_organizationId_idx" ON "Vendor"("organizationId");
CREATE INDEX "Vendor_archivedAt_idx" ON "Vendor"("archivedAt");
CREATE UNIQUE INDEX "Vendor_organizationId_name_key" ON "Vendor"("organizationId", "name");
CREATE INDEX "VendorRisk_organizationId_idx" ON "VendorRisk"("organizationId");
CREATE UNIQUE INDEX "VendorRisk_vendorId_key" ON "VendorRisk"("vendorId");

-- ============================================================ foreign keys

ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PHIType" ADD CONSTRAINT "PHIType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataFlow" ADD CONSTRAINT "DataFlow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiskHistory" ADD CONSTRAINT "RiskHistory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiskHistory" ADD CONSTRAINT "RiskHistory_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "Risk"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiskHistory" ADD CONSTRAINT "RiskHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiskHistory" ADD CONSTRAINT "RiskHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorRisk" ADD CONSTRAINT "VendorRisk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Threat" ADD CONSTRAINT "Threat_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Control" ADD CONSTRAINT "Control_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetControl" ADD CONSTRAINT "AssetControl_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetControl" ADD CONSTRAINT "AssetControl_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "Control"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyControl" ADD CONSTRAINT "PolicyControl_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyControl" ADD CONSTRAINT "PolicyControl_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "Control"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_threatId_fkey" FOREIGN KEY ("threatId") REFERENCES "Threat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "Control"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Remediation" ADD CONSTRAINT "Remediation_accessGrantId_fkey" FOREIGN KEY ("accessGrantId") REFERENCES "AccessGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
