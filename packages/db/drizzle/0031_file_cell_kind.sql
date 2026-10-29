-- New enum value is committed before any service can create a property using it.
ALTER TYPE property_kind ADD VALUE 'files';
--> statement-breakpoint
-- Cell usages retain their assignments while a property/row is archived.
CREATE FUNCTION file_usage_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.slot_kind='cell' AND NOT EXISTS(
   SELECT 1 FROM database_rows r JOIN database_properties p
   ON p.workspace_id=r.workspace_id AND p.database_id=r.database_id
   WHERE r.workspace_id=NEW.workspace_id AND r.page_id=NEW.page_id AND p.id=NEW.slot_id AND p.kind::text='files'
 ) THEN RAISE EXCEPTION 'Invalid file cell' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_usage_slot_guard BEFORE INSERT OR UPDATE ON file_usages FOR EACH ROW EXECUTE FUNCTION file_usage_slot_guard();
