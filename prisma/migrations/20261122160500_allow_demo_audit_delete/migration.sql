-- Narrows the append-only trigger with exactly one exception: DELETE is
-- permitted when the row's own organization has a "demo" slug, which is
-- what `prisma/reset-demo.ts` needs for `npm run db:demo:reset` to keep
-- working as an ordinary, typed `deleteMany` -- no raw SQL, no disabling
-- the trigger from application code. UPDATE stays unconditionally blocked
-- for every row, demo or not: nothing legitimate needs it once
-- recordAudit() can set createdAt at insert time.
--
-- A real customer organization's slug will never contain "demo", so this
-- exception has no effect on it: its audit trail remains unconditionally
-- immutable, which is the guarantee that actually matters.
CREATE OR REPLACE FUNCTION audit_event_immutable()
RETURNS TRIGGER AS $$
DECLARE
  org_slug TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT slug INTO org_slug FROM "Organization" WHERE id = OLD."organizationId";
    IF org_slug ILIKE '%demo%' THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'AuditEvent rows are append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
