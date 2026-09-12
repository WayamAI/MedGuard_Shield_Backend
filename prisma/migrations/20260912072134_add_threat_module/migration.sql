-- CreateEnum
CREATE TYPE "ThreatSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ThreatStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE');

-- CreateTable
CREATE TABLE "Threat" (
    "id" SERIAL NOT NULL,
    "assetId" INTEGER NOT NULL,
    "severity" "ThreatSeverity" NOT NULL,
    "status" "ThreatStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Threat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Threat_assetId_idx" ON "Threat"("assetId");

-- CreateIndex
CREATE INDEX "Threat_severity_idx" ON "Threat"("severity");

-- CreateIndex
CREATE INDEX "Threat_status_idx" ON "Threat"("status");

-- CreateIndex
CREATE INDEX "Threat_detectedAt_idx" ON "Threat"("detectedAt");

-- AddForeignKey
ALTER TABLE "Threat" ADD CONSTRAINT "Threat_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
