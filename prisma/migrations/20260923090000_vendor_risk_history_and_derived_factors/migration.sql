-- Vendor risk history, and derived risk factors.
--
-- RiskHistory becomes shared between assets and vendors rather than being
-- duplicated into a second table: the four factors, the formula, the bands and
-- the audit requirements are identical, and two tables would mean two places
-- to forget to write a row. `subjectType` says which kind of subject a row
-- describes; exactly one of assetId / vendorId is set.
--
-- Existing rows all describe assets, so the new column defaults to ASSET and
-- needs no backfill. `assetId` is widened to nullable for the vendor case.
--
-- Risk and VendorRisk gain per-factor override flags. Exposure and control gap
-- are now derived from observable facts and recomputed automatically; an
-- assessor who supplies either explicitly pins it, and the flag records that
-- their judgement outranks the derivation.

-- CreateEnum
CREATE TYPE "RiskSubject" AS ENUM ('ASSET', 'VENDOR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RiskChangeReason" ADD VALUE 'ASSET_CHANGED';
ALTER TYPE "RiskChangeReason" ADD VALUE 'PHI_CHANGED';
ALTER TYPE "RiskChangeReason" ADD VALUE 'ACCESS_CHANGED';
ALTER TYPE "RiskChangeReason" ADD VALUE 'VENDOR_ACCESS_CHANGED';
ALTER TYPE "RiskChangeReason" ADD VALUE 'CONTROL_CHANGED';
ALTER TYPE "RiskChangeReason" ADD VALUE 'THREAT_CHANGED';

-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "controlGapOverridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exposureOverridden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RiskHistory" ADD COLUMN     "subjectType" "RiskSubject" NOT NULL DEFAULT 'ASSET',
ADD COLUMN     "vendorId" INTEGER,
ADD COLUMN     "vendorRiskId" INTEGER,
ALTER COLUMN "assetId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "VendorRisk" ADD COLUMN     "controlGapOverridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exposureOverridden" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "RiskHistory_vendorId_changedAt_idx" ON "RiskHistory"("vendorId", "changedAt");

-- CreateIndex
CREATE INDEX "RiskHistory_subjectType_changedAt_idx" ON "RiskHistory"("subjectType", "changedAt");

-- AddForeignKey
ALTER TABLE "RiskHistory" ADD CONSTRAINT "RiskHistory_vendorRiskId_fkey" FOREIGN KEY ("vendorRiskId") REFERENCES "VendorRisk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskHistory" ADD CONSTRAINT "RiskHistory_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

