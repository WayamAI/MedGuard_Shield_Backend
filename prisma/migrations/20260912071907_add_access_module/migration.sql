-- CreateEnum
CREATE TYPE "IdentityKind" AS ENUM ('USER', 'SERVICE_ACCOUNT');

-- CreateEnum
CREATE TYPE "AccessLevel" AS ENUM ('READ', 'WRITE', 'ADMIN');

-- CreateTable
CREATE TABLE "Identity" (
    "id" SERIAL NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "kind" "IdentityKind" NOT NULL DEFAULT 'USER',
    "department" TEXT,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" SERIAL NOT NULL,
    "identityId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "level" "AccessLevel" NOT NULL DEFAULT 'READ',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Identity_email_key" ON "Identity"("email");

-- CreateIndex
CREATE INDEX "Identity_kind_idx" ON "Identity"("kind");

-- CreateIndex
CREATE INDEX "Identity_active_idx" ON "Identity"("active");

-- CreateIndex
CREATE INDEX "AccessGrant_assetId_idx" ON "AccessGrant"("assetId");

-- CreateIndex
CREATE INDEX "AccessGrant_lastUsedAt_idx" ON "AccessGrant"("lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_identityId_assetId_key" ON "AccessGrant"("identityId", "assetId");

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
