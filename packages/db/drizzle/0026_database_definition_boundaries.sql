ALTER TABLE "database_cell_versions" DROP CONSTRAINT "database_cell_versions_workspace_id_property_id_database_properties_workspace_id_id_fk";
--> statement-breakpoint
ALTER TABLE "database_properties" ADD CONSTRAINT "properties_database_id_uq" UNIQUE("workspace_id","database_id","id");
--> statement-breakpoint
ALTER TABLE "database_cell_versions" ADD CONSTRAINT "database_cell_versions_workspace_id_database_id_property_id_database_properties_workspace_id_database_id_id_fk" FOREIGN KEY ("workspace_id","database_id","property_id") REFERENCES "public"."database_properties"("workspace_id","database_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Definitions and assignable-person visibility share the same base barrier as writers.
-- Services acquire all bases in UUID order before editing definitions and own schema CAS.
CREATE FUNCTION database_definition_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; b uuid; populated boolean;
BEGIN
 IF TG_OP='DELETE' THEN w:=OLD.workspace_id; b:=OLD.database_id;
 ELSE w:=NEW.workspace_id; b:=NEW.database_id; END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.database_id) IS DISTINCT FROM (OLD.workspace_id,OLD.database_id) THEN
  RAISE EXCEPTION 'immutable database scope' USING ERRCODE='23514';
 END IF;
 PERFORM id FROM databases WHERE workspace_id=w AND id=b FOR UPDATE;
 IF TG_TABLE_NAME='database_properties' AND TG_OP='UPDATE' THEN
  IF (NEW.kind,NEW.config->>'mode',NEW.relation_target_database_id) IS DISTINCT FROM (OLD.kind,OLD.config->>'mode',OLD.relation_target_database_id) THEN
   SELECT EXISTS(SELECT 1 FROM property_values WHERE workspace_id=w AND property_id=OLD.id)
    OR EXISTS(SELECT 1 FROM multi_select_values WHERE workspace_id=w AND property_id=OLD.id)
    OR EXISTS(SELECT 1 FROM relation_values WHERE workspace_id=w AND property_id=OLD.id)
    OR EXISTS(SELECT 1 FROM person_values WHERE workspace_id=w AND property_id=OLD.id) INTO populated;
   IF populated THEN RAISE EXCEPTION 'populated property definition' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE TRIGGER database_property_barrier BEFORE INSERT OR UPDATE OR DELETE ON database_properties FOR EACH ROW EXECUTE FUNCTION database_definition_barrier();
CREATE TRIGGER database_option_barrier BEFORE INSERT OR UPDATE OR DELETE ON property_options FOR EACH ROW EXECUTE FUNCTION database_definition_barrier();
CREATE TRIGGER database_view_barrier BEFORE INSERT OR UPDATE OR DELETE ON database_views FOR EACH ROW EXECUTE FUNCTION database_definition_barrier();
CREATE TRIGGER database_assignable_barrier BEFORE INSERT OR UPDATE OR DELETE ON database_assignable_people FOR EACH ROW EXECUTE FUNCTION database_definition_barrier();
