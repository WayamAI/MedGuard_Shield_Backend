-- Corrects the DELETE exception added in allow_demo_audit_delete.
--
-- That version keyed the exception off the row's own Organization.slug
-- containing "demo", which was wrong on every axis that mattered:
--   1. The Meridian demo org's slug is "meridian", not "...demo...", so the
--      exception never actually applied to the org this product demos with.
--   2. A real customer whose slug happens to contain "demo" (e.g. a company
--      named "Demographics Health") would have silently lost audit
--      immutability -- the opposite of what this trigger exists to guarantee.
--   3. It didn't match reset-demo.ts's own safety guard, which is already
--      keyed off the DATABASE name, not any row's content.
--
-- The fix keys the same way the application-level guard already does:
-- DELETE is permitted only when the current database's own name contains
-- "demo" -- i.e. only when this trigger is running inside a database that
-- was itself provisioned as a demo/test database, never based on what any
-- row says about itself. UPDATE remains unconditionally blocked everywhere.
CREATE OR REPLACE FUNCTION audit_event_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_database() ILIKE '%demo%' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'AuditEvent rows are append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
