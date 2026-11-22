-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prevHash" TEXT;

-- Append-only enforcement at the database layer, independent of the hash
-- chain above. Even a caller with a raw SQL connection to this database
-- (bypassing the Prisma client and every application-layer check) cannot
-- UPDATE or DELETE an audit row -- the trigger raises before Postgres
-- commits the statement.
CREATE OR REPLACE FUNCTION audit_event_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent rows are append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
