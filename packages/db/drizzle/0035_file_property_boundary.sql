-- The existing definition trigger locks the base before this fence. File-cell writers
-- take the same base latch, so changing a populated files column cannot orphan its ledger.
CREATE FUNCTION file_property_definition_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS(
  SELECT 1 FROM file_usages WHERE workspace_id=OLD.workspace_id AND slot_kind='cell' AND slot_id=OLD.id
 ) THEN
  RAISE EXCEPTION 'populated file property definition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER file_property_definition_fence BEFORE UPDATE ON database_properties FOR EACH ROW EXECUTE FUNCTION file_property_definition_fence();
