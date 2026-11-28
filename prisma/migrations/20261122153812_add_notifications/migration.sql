-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('THREAT_NEW_HIGH_SEVERITY', 'REMEDIATION_OVERDUE', 'VENDOR_BAA_INVALID', 'VENDOR_ASSESSMENT_OVERDUE', 'POLICY_REVIEW_OVERDUE', 'ACCESS_GRANT_FLAGGED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'SYSTEM_SWEEP_COMPLETED';

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "readByUserIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_organizationId_createdAt_idx" ON "Notification"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_organizationId_dedupeKey_key" ON "Notification"("organizationId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
