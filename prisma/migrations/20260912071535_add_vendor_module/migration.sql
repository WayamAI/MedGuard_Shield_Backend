-- CreateEnum
CREATE TYPE "BaaStatus" AS ENUM ('SIGNED', 'PENDING', 'EXPIRED', 'MISSING');

-- CreateTable
CREATE TABLE "Vendor" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "baaStatus" "BaaStatus" NOT NULL DEFAULT 'MISSING',
    "phiVolume" INTEGER NOT NULL DEFAULT 0,
    "lastAssessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAssetAccess" (
    "vendorId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorAssetAccess_pkey" PRIMARY KEY ("vendorId","assetId")
);

-- CreateTable
CREATE TABLE "VendorRisk" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "likelihood" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "exposure" INTEGER NOT NULL,
    "controlGap" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "band" "RiskBand" NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorRisk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE INDEX "Vendor_baaStatus_idx" ON "Vendor"("baaStatus");

-- CreateIndex
CREATE INDEX "VendorAssetAccess_assetId_idx" ON "VendorAssetAccess"("assetId");

-- CreateIndex
CREATE INDEX "VendorRisk_vendorId_idx" ON "VendorRisk"("vendorId");

-- CreateIndex
CREATE INDEX "VendorRisk_band_idx" ON "VendorRisk"("band");

-- AddForeignKey
ALTER TABLE "VendorAssetAccess" ADD CONSTRAINT "VendorAssetAccess_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssetAccess" ADD CONSTRAINT "VendorAssetAccess_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorRisk" ADD CONSTRAINT "VendorRisk_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
