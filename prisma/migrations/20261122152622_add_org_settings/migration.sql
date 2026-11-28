-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'SETTINGS_UPDATED';

-- CreateTable
CREATE TABLE "OrganizationSettings" (
    "organizationId" INTEGER NOT NULL,
    "accessStaleAfterDays" INTEGER NOT NULL DEFAULT 90,
    "assessmentCadenceDays" INTEGER NOT NULL DEFAULT 365,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationSettings_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "OrganizationSettings" ADD CONSTRAINT "OrganizationSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
