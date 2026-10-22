-- Tree writes must also acquire the workspace advisory lock in the writer service
-- BEFORE the mutation statement. Triggers provide a second line of defense.
CREATE FUNCTION check_page_tree() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text, 0));
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
      UNION
      SELECT p.id, p.parent_id FROM pages p JOIN ancestors a ON p.id = a.parent_id WHERE p.workspace_id = NEW.workspace_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE EXCEPTION 'Page tree cycle' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pages_tree BEFORE INSERT OR UPDATE OF parent_id ON pages FOR EACH ROW EXECUTE FUNCTION check_page_tree();
--> statement-breakpoint
CREATE FUNCTION check_block_tree() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text, 0));
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM blocks WHERE workspace_id = NEW.workspace_id AND page_id = NEW.page_id AND id = NEW.parent_id
      UNION
      SELECT b.id, b.parent_id FROM blocks b JOIN ancestors a ON b.id = a.parent_id WHERE b.workspace_id = NEW.workspace_id AND b.page_id = NEW.page_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE EXCEPTION 'Block tree cycle' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER blocks_tree BEFORE INSERT OR UPDATE OF parent_id, page_id ON blocks FOR EACH ROW EXECUTE FUNCTION check_block_tree();
--> statement-breakpoint
CREATE FUNCTION check_key_policy_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_keys WHERE id = NEW.credential_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'API credential belongs to another workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER key_policy_workspace BEFORE INSERT OR UPDATE OF credential_id, workspace_id ON api_key_policies FOR EACH ROW EXECUTE FUNCTION check_key_policy_workspace();
--> statement-breakpoint
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
--> statement-breakpoint
CREATE FUNCTION keep_workspace_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'Workspace identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE row record; BEGIN
  FOR row IN SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'updated_at' LOOP
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', row.table_name);
  END LOOP;
  FOR row IN SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'workspace_id' LOOP
    EXECUTE format('CREATE TRIGGER keep_workspace_id BEFORE UPDATE OF workspace_id ON %I FOR EACH ROW EXECUTE FUNCTION keep_workspace_id()', row.table_name);
  END LOOP;
END $$;
