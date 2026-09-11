-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('EHR', 'DATABASE', 'API', 'CLOUD_STORAGE', 'ANALYTICS', 'OTHER');

-- CreateEnum
CREATE TYPE "Sensitivity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskBand" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'CRITICAL', 'EXTREME');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "externalAuthId" TEXT,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "phiVolume" INTEGER NOT NULL DEFAULT 0,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastAssessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PHIType" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sensitivity" "Sensitivity" NOT NULL,

    CONSTRAINT "PHIType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetPHI" (
    "assetId" INTEGER NOT NULL,
    "phiTypeId" INTEGER NOT NULL,
    "recordsPerDay" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AssetPHI_pkey" PRIMARY KEY ("assetId","phiTypeId")
);

-- CreateTable
CREATE TABLE "DataFlow" (
    "id" SERIAL NOT NULL,
    "sourceAssetId" INTEGER NOT NULL,
    "targetAssetId" INTEGER NOT NULL,
    "phiTypeId" INTEGER NOT NULL,
    "recordsPerDay" INTEGER NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DataFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Risk" (
    "id" SERIAL NOT NULL,
    "assetId" INTEGER NOT NULL,
    "likelihood" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "exposure" INTEGER NOT NULL,
    "controlGap" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "band" "RiskBand" NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Risk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_externalAuthId_key" ON "User"("externalAuthId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_name_key" ON "Asset"("name");

-- CreateIndex
CREATE INDEX "Asset_type_idx" ON "Asset"("type");

-- CreateIndex
CREATE UNIQUE INDEX "PHIType_name_key" ON "PHIType"("name");

-- CreateIndex
CREATE INDEX "PHIType_sensitivity_idx" ON "PHIType"("sensitivity");

-- CreateIndex
CREATE INDEX "AssetPHI_phiTypeId_idx" ON "AssetPHI"("phiTypeId");

-- CreateIndex
CREATE INDEX "DataFlow_sourceAssetId_idx" ON "DataFlow"("sourceAssetId");

-- CreateIndex
CREATE INDEX "DataFlow_targetAssetId_idx" ON "DataFlow"("targetAssetId");

-- CreateIndex
CREATE INDEX "DataFlow_phiTypeId_idx" ON "DataFlow"("phiTypeId");

-- CreateIndex
CREATE INDEX "Risk_assetId_idx" ON "Risk"("assetId");

-- CreateIndex
CREATE INDEX "Risk_band_idx" ON "Risk"("band");

-- CreateIndex
CREATE INDEX "Risk_computedAt_idx" ON "Risk"("computedAt");

-- AddForeignKey
ALTER TABLE "AssetPHI" ADD CONSTRAINT "AssetPHI_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetPHI" ADD CONSTRAINT "AssetPHI_phiTypeId_fkey" FOREIGN KEY ("phiTypeId") REFERENCES "PHIType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataFlow" ADD CONSTRAINT "DataFlow_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataFlow" ADD CONSTRAINT "DataFlow_targetAssetId_fkey" FOREIGN KEY ("targetAssetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataFlow" ADD CONSTRAINT "DataFlow_phiTypeId_fkey" FOREIGN KEY ("phiTypeId") REFERENCES "PHIType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
